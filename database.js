var orm = require('orm'),
    util = require('util'),
    config = require('./config'),
    fs = require('fs'),
    events = require('events'),
    mysql = require('mysql'),
    geoip = require('geoip-lite'),
    models = {},
    eventEmitter = new events.EventEmitter();

orm.connect("mysql://"+config.db.user+":"+config.db.password+"@"+config.db.host+"/"+config.db.database+'?pool=true', function (err, db) {
    if (err) {
        console.log("Something is wrong with the db connection", err);
        return;
    }
    
    // check for migrations before setting up models
    models.Migration = db.define('migrations', {
        number: { type: "number" },
        name: { type: "text" },
        timestamp: { type: "date" }
    });
    models.Migration.sync(function (err) {
        if (err) {
            console.log(err);
            throw err;
        }
    });
    // listen to migrations done and launch models setup when we get that
    eventEmitter.on('migrations-done', setUpModels);
    // get migrations
    models.Migration.find({}, function (error, result) {
        var migratefiles = fs.readdirSync('migrations/').sort();
        var migrations = [];
        if (migratefiles.length) {
            // separate non-orm mysql connection for flexibility
            var dbconfig = config.db;
            dbconfig.multipleStatements = true;
            var migrdb = mysql.createConnection(dbconfig);
            migrdb.connect(function (err) {
                if (err) {
                    console.log(err);
                    throw err;
                }
            });
            var migrations = [];
            migrdb.beginTransaction(function (err) {
                if (err) {
                    console.log(err);
                    throw err;
                }
                // collect migrations
                for (var i=0; i<migratefiles.length; i++) {
                    if (migratefiles[i].indexOf('.sql') < 0) {
                        continue;
                    }
                    var migration = {
                        number: parseInt(migratefiles[i].split('-')[0]),
                        name: migratefiles[i].split('-')[1],
                        filename: 'migrations/'+migratefiles[i],
                    }
                    if (result) {
                        var done = false;
                        for (var j=0; j<result.length; j++) {
                            if (result[j].number == migration.number) {
                                // done already
                                done = true;
                                break;
                            }
                        }
                        if (done) {
                            continue;
                        }
                    }
                    var sql = fs.readFileSync(migration.filename, { encoding: 'utf8' });
                    migration.sql = sql;
                    migrations.push(migration);
                }
                // launch migrations if found
                if (migrations.length) {
                    doMigration(migrations, migrdb, db);
                } else {
                    eventEmitter.emit('migrations-done', db);
                    migrdb.end();
                }
            });
        } else {
            eventEmitter.emit('migrations-done', db);
        }
    });
});

function doMigration(migrations, migrdb, db) {
    var migration = migrations.shift();
    console.log('processing: '+migration.name);
    migrdb.query(migration.sql, function(err, rows, fields) {
        if (err) {
            // migration failed
            console.log("Error: " + err.message);
            migrdb.rollback(function() {
                throw err;
            });
        } else {
            migrdb.commit(function(err) {
                if (err) { 
                    migrdb.rollback(function() {
                        throw err;
                    });
                }
                console.log('success!');
                models.Migration.create({
                    number: migration.number,
                    name: migration.name,
                    timestamp: new Date()
                }, function (err, items) {
                    if (err)
                        console.log("Database error when inserting migration: "+err);
                });
                if (migrations.length) {
                    // do next
                    doMigration(migrations, migrdb, db);
                } else {
                    // no more, set up models
                    console.log('** Migrations done, launching app.. **');
                    eventEmitter.emit('migrations-done', db);
                    migrdb.end();
                }
            });
        }
    });    
}

function setUpModels(db) {
    // set up models
    models.Pod = db.define('pods', {
        name: { type: "text", size: 300 },
        // due to this bug (https://github.com/dresende/node-orm2/issues/326) host not set unique yet..
        host: { type: "text", size: 100 },
        version: { type: "text", size: 30 },
        registrations_open: { type: "boolean" },
        failures: { type: "number" },
        ip4: { type: "text", size: 15 },
        country: { type: "text", size: 10 },
    }, {
        methods: {
            needsUpdate: function (name, version, registrations_open, ip4) {
                return (this.name !== name || this.version !== version || this.registrations_open !== registrations_open || this.ip4 !== ip4);
            },
            logStats: function (data) {
                var podId = this.id;
                var today = new Date();
                models.Stat.find({ pod_id: this.id, date: new Date(today.getFullYear(), today.getMonth(), today.getDate()) }, function(err, stats) {
                    if (! stats.length) {
                        if (! isNaN(data.total_users) || ! isNaN(data.active_users_halfyear) || ! isNaN(data.active_users_monthly) || isNaN(data.local_posts)) {
                            models.Stat.create({
                                date: new Date(),
                                total_users: (isNaN(data.total_users)) ? 0 : data.total_users,
                                active_users_halfyear: (isNaN(data.active_users_halfyear)) ? 0 : data.active_users_halfyear,
                                active_users_monthly: (isNaN(data.active_users_monthly)) ? 0 : data.active_users_monthly,
                                local_posts: (isNaN(data.local_posts)) ? 0 : data.local_posts,
                                pod_id: podId,
                            }, function (err, items) {
                                if (err)
                                    console.log("Database error when inserting stat: "+err);
                            });
                        }
                    }
                });
            },
            logFailure: function() {
                this.failures += 1;
                this.save(function (err) {
                    if (err) console.log(err);
                });
            },
            getCountry: function() {
                if (this.ip4) {
                    geo = geoip.lookup(this.ip4);
                    if (typeof geo.country !== 'undefined' && geo.country) {
                        this.country = geo.country;
                        this.save(function (err) {
                            if (err) console.log(err);
                        });
                    }
                }
            },
        }
    });
    models.Pod.allForList = function (callback) {
        db.driver.execQuery(
            "SELECT p.name, p.host, p.version, p.registrations_open, p.country,\
                (select total_users from stats where pod_id = p.id order by id desc limit 1) as total_users,\
                (select active_users_halfyear from stats where pod_id = p.id order by id desc limit 1) as active_users_halfyear,\
                (select active_users_monthly from stats where pod_id = p.id order by id desc limit 1) as active_users_monthly,\
                (select local_posts from stats where pod_id = p.id order by id desc limit 1) as local_posts FROM pods p\
                    where failures < 3",
            [],
            function (err, data) {
                if (err) console.log(err);
                callback(data);
            }
        );
    };
    models.Pod.allPodStats = function (item, callback) {
        db.driver.execQuery(
            "SELECT p.name, s.pod_id, unix_timestamp(s.date) as timestamp, s."+item+" as item FROM pods p, stats s where p.failures < 3 and p.id = s.pod_id order by s.date",
            [],
            function (err, data) {
                if (err) console.log(err);
                callback(data);
            }
        );
    };
    models.Stat = db.define('stats', {
        date: { type: "date", time: false },
        total_users: { type: "number" },
        active_users_halfyear: { type: "number" },
        active_users_monthly: { type: "number" },
        local_posts: { type: "number" },
    });
    models.Stat.hasOne('pod', models.Pod, { reverse: 'stats' });
    models.GlobalStat = db.define('global_stats', {
        date: { type: "date", time: false },
        total_users: { type: "number" },
        active_users_halfyear: { type: "number" },
        active_users_monthly: { type: "number" },
        local_posts: { type: "number" },
        new_users: { type: "number" },
        new_posts: { type: "number" },
    });
    
    models.Pod.sync(function (err) {
        if (err) console.log(err);
    });
    models.Stat.sync(function (err) {
        if (err) console.log(err);
    });
    models.GlobalStat.sync(function (err) {
        if (err) {
            console.log(err);
        } else {
            // make sure all dates have a global stat record
            db.driver.execQuery(
            "SELECT distinct date FROM stats order by date",
            [],
            function (err, data) {
                if (err) {
                    console.log(err);
                } else {
                    for (var i=0; i<data.length; i++) {
                        var date = data[i].date;
                        models.GlobalStat.exists({ date: date }, function (err, exists) {
                            if (! exists) {
                                // collect
                                models.Stat.aggregate({ date: date }).sum("total_users").sum("active_users_halfyear").sum("active_users_monthly").sum("local_posts").get(function (err, total_users, active_users_halfyear, active_users_monthly, local_posts) {
                                    var data = {
                                        date: date,
                                        total_users: total_users,
                                        active_users_monthly: active_users_monthly,
                                        active_users_halfyear: active_users_halfyear,
                                        local_posts: local_posts
                                    }
                                    var prevDate = new Date(date);
                                    prevDate.setDate(prevDate.getDate()-1);
                                    models.Stat.exists({ date: prevDate.toISOString() }, function (err, exists) {
                                        if (exists) {
                                            models.Stat.aggregate({ date: prevDate.toISOString() }).sum("total_users").sum("local_posts").get(function (err, total_users, local_posts) {
                                                data.new_users = data.total_users - total_users;
                                                data.new_posts = data.local_posts - local_posts;
                                                models.GlobalStat.create(data, function (err, items) {
                                                    if (err) console.log("Database error when global stat: "+err);
                                                });
                                            });
                                        } else {
                                            data.new_users = 0;
                                            data.new_posts = 0;
                                            models.GlobalStat.create(data, function (err, items) {
                                                if (err) console.log("Database error when global stat: "+err);
                                            });
                                        }
                                    })
                                });
                            }
                        });
                    }
                }
            });
        }
    });
}    

module.exports = models;