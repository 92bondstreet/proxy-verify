/**
 * verify.js takes a list of HTTP proxies and will attempt to establish a connection to a target site using each proxy.
 * The proxies that successfully connect and enable you to hide your own IP/Host will be saved.
 *
 * You can specify the unverified proxies as either the path to a single file, or a directory containing multiple files.
 * The script expects the file(s) to contain proxies in the below format:
 * ip:port
 *
 * Installation:
 *
 * Copy verify.js into it's own directory then run:
 * > npm install
 * > chmod +x verify.js
 *
 * Basic usage:
 *
 * ./verify.js -i proxies.txt -o proxies_verified.txt
 * Will read a the input proxies from the file proxies.txt and save verified proxies to proxies_verified.txt
 *
 * ./verify.js -i proxies/ -o proxies_verified.txt -u "http://digg.com"
 *
 * As a module:
 *
 * This script can also be used as a module, which is helpful if you want to control the flow to and from the program
 * to do this use the following in your new file:
 *
 *  const Verify = require('./verify');
 *  var verifyObj = { url: 'http://google.com'}  // all options are available here
 *  var verify = new Verify(verifyObj);
 *  verify.main();
 *
 *  // you can also listen for events (all events are the same in verify but prepended w/ ext)
 *  verify.on('extverifiedProxy', function(data) { .. });
 *
 * A full list of events are here:
 *  extverifiedProxy, (data)
 *  extdone, ()
 *
 *
 * (c) jthatch http://github.com/jthatch
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/*eslint-disable no-underscore-dangle*/
'use strict';

// internal nodejs libraries
const chalk = require('chalk');
const cheerio = require('cheerio');
const fs = require('fs');
const util = require('util');
const path = require('path');
const cluster = require('cluster');
const EventEmitter = require('events').EventEmitter;
const request = require('superagent');
const url = require('url');

const log = require('./log');

require('superagent-proxy')(request);

const SHUTDOWN_TIMEOUT = 1000 * 60 * 10;

/**
 * Replace the given file extension
 * @param  {String} current
 * @param  {String} extension
 * @return {String}
 */
function replaceExt (current, extension) {
  if (typeof current !== 'string') {
    return current;
  }

  if (current.length === 0) {
    return current;
  }

  const file = path.basename(current, path.extname(current)) + extension;

  return path.join(path.dirname(current), file);
}

process.on('uncaughtException', (err) => {
  console.log(`Caught exception: ${err}`);
});

/**
 * This follows the observer design pattern. We take arguments first from options, then argv then resort to defaults
 * @constructor
 */
function Verify(options) {
    options = options || {};
    // the url we'll use to verify the proxies
    this.url = options.url || "http://digg.com/";
    // number of instances of program to run
    this.workers = options.workers || require('os').cpus().length;
    // hard limit, feel free to remove this, but I find anymore than 4 is overkill
    if (this.workers > 4)
        this.workers = 4;
    // number of HTTP requests. Setting this too high might give false positives to broken proxies
    this.concurrentRequests = options.concurrentRequests || this.workers * 30;
    // can be either a file path or a directory path containing files
    this.inputFile = options.inputFile ||
        __dirname + '/proxies/fetched/fetched_proxies_{date}.txt'.replace(/\//g, path.sep);
        //process.cwd() + '/proxies/fetched/'.replace(/\//g, path.sep);
    // where we store the verified proxies
    this.outputFile = options.outputFile ||
        __dirname + '/proxies/verified/verified_proxies_{date}.txt'.replace(/\//g, path.sep);
        //process.cwd() + "/proxies/verfied/verified_all.txt".replace(/\//g, path.sep);
    // the timeout before we cancel the request
    this.requestTimeout = options.requestTimeout || 10000;
    // enforce the timeout even if the proxy has established a connection
    // use if you want to weed out slow running proxies
    this.strict = options.strict || true;
    // for ip lookup
    this.ip = options.ip || false;
    // show extra debug info
    this.verbose = options.verbose || false;
    // store the speed of verify to a log file, appended for comparison
    this.debug = options.debug || false;
    // disable output
    this.noOutput = options.noOutput || false;
    // regex for matching body content, you don't need the enclosing /. this will inc a counter each time a match occurs
    this.regex = options.regex || false;
    // selector for matching body content
    this.selector = options.selector || false;
    // we allow to give list of fetch proxies by requiring the module
    this.fetch = options.fetch || false;
    // file format to save the list of proxies
    this.export = options.export;
    // limit of good proxies to save
    this.limit = options.limit || -1;

    // No point having workers that do nothing, so set the no. of concurrent requests to match the no. of workers
    if (this.workers > this.concurrentRequests)
        this.concurrentRequests = this.workers;

    // if strict we'll use iplookup.flashfxp.com wihch returns the originating ip address to confirm our proxy
    if (this.ip)
        this.url = "http://iplookup.flashfxp.com/";

    // internal variables
    this._proxies = [];
    this._verifiedProxies = [];
    this._workersFinished = 0;
    this._stats = {
        good : 0, // good proxies
        bad : 0, // bad
        total: 0, // total proxies
        done : 0, // incrementing counter
        regex: 0, // regex incrementing counter
        // for calculating average response times of proxies
        responses : [],
        avg : 0
    };
    this._startTime = new Date().getTime();

    EventEmitter.call(this);

    this.shutdownTimeout = setTimeout(() => {
      this.log('c:bgRed', 'global timeout, it takes too time to verify');
      this.shutdown()
    }, SHUTDOWN_TIMEOUT);
}

Verify.prototype.main = function() {
    var _this = this;

    // Our master thread appropriates tasks to all workers and coordinates the program flow
    if (cluster.isMaster) {

        _this.log("Verifying proxies using ", "c:bold", this.url,
            " with ", "c:bold", this.workers, " workers, ",
            "c:bold", this.concurrentRequests, " concurrent requests",
            " and a ", (this.strict ? chalk.bold('strict ') : ''), "c:bold", this.requestTimeout, "ms timeout",
            (this.regex ? 'using regex /' + this.regex + '/' : ''));

        if (this.debug) {
            var date = new Date().toISOString().substring(0,19).replace('T', ' ');
            var debug = date + " URL: " +this.url +
            " Workers: " + this.workers + " Requests: " +
            this.concurrentRequests +
            " " + (this.strict ? 'Strict Timeout: ' : 'Timeout: ') + this.requestTimeout +
            (this.regex ? ' Regex: /' + this.regex + '/' : '') + "\n";
            this.debugLog(debug);
        }

        if (this.verbose)
            this.showOptions();

        // spawn our worker threads immediately as this is non-blocking but takes a little while
        for (var i = 0; i < this.workers; i++) {
            cluster.fork();
        }

        // receive messages from our worker threads
        Object.keys(cluster.workers).forEach(function (id) {
            _this.log("worker ", "c:bold", '#' + id,' is online');

            cluster.workers[id].on('message', function (msg) {
                if (msg.cmd) {
                    switch (msg.cmd) {
                        case 'verifiedProxy':
                            var data = msg.data;

                            // emit for use as a module
                            _this.emit('extVerifiedProxy', data);
                            _this._stats.done++;
                            var total = Math.round(_this._stats.done / _this._stats.total * 100);
                            // good proxy
                            if (!data.err) {
                                // attempt to match body content
                                // the regex validation is a strict validation
                                if (_this.regex) {
                                    var re = new RegExp(_this.regex);
                                    // easier to just convert it to a string
                                    if (re.exec(JSON.stringify(data.data))) {
                                        _this.good(data);
                                    }
                                } else {
                                  _this.good(data);
                                }

                                _this.log("c:gray bold", total + '% ', "c:green", "\u2714 ", "c:green bold", data.proxy,
                                    "c:green", " in " + _this.runTime(data.duration),
                                    (_this.regex ? (chalk.green(' [') + chalk.green.bold(_this._stats.regex) + chalk.green('] ')) : ''),
                                    (_this.verbose ? chalk.gray.bold(' ' +
                                        JSON.stringify(data.data).replace(/":"/g, ",") // headers
                                            .replace(/"/g, '')
                                            .replace(/\{/g, '')
                                            .substr(0, 100))
                                        : ''
                                    )
                                );

                                _this.saveProxies();
                            }
                            else {
                                _this._stats.bad++;
                                _this.log("c:gray bold", total + '% ', "c:red", "\u2716 ", "c:red bold", data.proxy,
                                    "c:red", " error ", "c:red bold", data.err.code,
                                    "c:red", " in " + _this.runTime(data.duration));
                            }

                            if (_this._stats.done == _this._stats.total || _this._stats.good === _this.limit) {
                              return _this.shutdown(data);
                            }
                            else {
                                _this.dispatchRequest(id);
                            }

                            break;
                    }
                }
            });
        });

        // bind our callbacks
        _this.on('readProxies', function(proxies){
            // Ensure we dont have more concurrentRequests than proxies
            if (_this.concurrentRequests > proxies.length)
                _this.concurrentRequests = proxies.length;

            _this.startWorkers(proxies);
        });

        // now initiate the first function to read our proxies
        // either from module
        // either from input file
        if (this.fetch) {
          return this.emit('fetchProxies');
        }

        if (!this.readProxies())
            process.exit();

    }
    // worker
    else {
        // receive messages from master
        process.on('message', function(msg) {
            if (msg.cmd) {
                switch(msg.cmd) {
                    case 'verifyProxy':
                        try {
                          _this.verifyProxy(msg.data);
                        } catch (e) {
                          _this.broadcastToMaster('verifiedProxy', {'err': {'code': 'UNABLE_TO_VERIFY'}});
                        };
                        break;
                    case 'shutdown':
                        process.disconnect();
                        break;
                    default:
                        _this.log('Invalid msg: ' + msg.cmd + ': ' + JSON.stringify(msg.data));
                        break;
                }
            }
        });

    }
};

Verify.prototype.good = function (data) {
  var _this = this;

  _this._stats.regex++;
  _this._verifiedProxies.push(data.proxy);
  _this._stats.good++;
  _this._stats.responses.push(((new Date().getTime() - data.duration) / 1e3));
}

/**
 * Start handing out proxies to the workers. As they complete their request they'll automatically be given the next
 * until there's no proxies left to verify
 * @param proxies
 */
Verify.prototype.startWorkers = function(proxies) {
    var _this = this;

    this._proxies = proxies;
    this._stats.total = proxies.length;

    var lastWorker = 1;
    var requestsInProgress = 0;
    while ( ( requestsInProgress < this.concurrentRequests ) && this._proxies.length ) {
        var proxy = this._proxies.shift();
        lastWorker = lastWorker > this.workers ? 1 : lastWorker;
        this.broadcastToWorkers(lastWorker++, 'verifyProxy', proxy);

        requestsInProgress++;
    }
};

/**
 * Attempts to establish a connection to the remote host using the proxy.
 * @emit verifyProxy (proxy, error, response, duration)
 * @param proxy
 */
Verify.prototype.verifyProxy = function(proxy) {
    var _this = this;
    var startTime = new Date().getTime();
    var [host, port] = proxy.split(':');
    var randInt = Math.round(Math.random()*10000);
    _this.url = _this.url.replace(/{randint}/g, randInt);
    var headerHost = url.parse(_this.url).hostname;
    var r;
    var returned = false;
    var selector = _this.selector;
    var returnBroadcast = function(data) {
        if (returned)
            return false;
        returned = true;
        data.duration = startTime;
        data.proxy = proxy;
        _this.broadcastToMaster('verifiedProxy',data);
    };
    if (this.strict) {
        var timer = setTimeout(function() {
            r.abort();
            returnBroadcast({err: {code: 'STRICT_TIMEOUT'},  response: {}});
        }, _this.requestTimeout);
    }

    const agent = request.agent();

    r = agent
      .get(_this.url)
      .set('Host', headerHost)
      .set('User-Agent', _this.userAgent())
      .proxy(`http://${proxy}`)
      .timeout(_this.requestTimeout)
      .end(function (err, res) {
        if (err) {
          const code = err.status || err.message;

          clearTimeout(timer);
          return returnBroadcast({err: {code}, headers: {}});
        }
        var data = res.text;

        clearTimeout(timer);

        if (_this.ip) {
            if (data != host) {
                returnBroadcast({err: {code:"PROXY_MISMATCH"}, headers: res.headers, data: data});
            }
            else {
                returnBroadcast({err: null, headers: res.headers, data: data});
            }
        }
        else {
          var regEx = /^[2-3][0-9][0-9]$/

          if (! regEx.test(res.statusCode)) {
            return returnBroadcast({err: {code:"STATUS_4xx_5xx"}, headers: res.headers, data: data});
          }

          if (selector) {
            if (_this.query(data, selector)) {
              returnBroadcast({err: null, headers: res.headers, data: data, redirects: res.redirects});
            }
            else {
              returnBroadcast({err: {code:"SELECTOR_NOT_FOUND"}, headers: res.headers, data: data, redirects: res.redirects});
            }
          }

          returnBroadcast({err: null, headers: res.headers, data: data});
        }
      });
};

/**
 * Dispatch a request to a particular worker assuming there's any proxies left
 * @param id
 */
Verify.prototype.dispatchRequest = function(id) {
    var _this = this;
    //this._workersFinished++;
    // If we still have proxies available to verify, send them to the worker id
    if (this._proxies.length) {
        var proxy = this._proxies.shift();
        this.broadcastToWorkers(id, 'verifyProxy', proxy);
    }
};

/**
 * Read proxies from a file or directory, remove duplicates and validate
 * @emit readProxies (proxies)
 * @returns {boolean}
 */
Verify.prototype.readProxies = function() {
    var _this = this;

    var files = [];
    var proxies = [];
    var readFile = function(fileName) {
        proxies.push.apply(proxies, fs.readFileSync(fileName).toString('utf8').split('\n'));
    };

    // if it's an array of input files let's iterate over them
    if (typeof _this.inputFile == 'object') {
        this.inputFile.forEach( (val, index, arr) => {
            var inputFile = val.trim();

            inputFile = String(inputFile).replace("{date}", _this.dateStamp());

            if (fs.existsSync(inputFile)) {
                readFile(inputFile);
            }
            else {
                _this.log("c:bgRed", "error: unable to read: " + inputFile);
                return false;
            }
        })
    }
    // Otherwise inputFile could be either a single file or a directory
    else {
        // if we find the variable {date} we'll replace it with todays date in the format dd-mm-yyyy
        this.inputFile = String(this.inputFile).replace("{date}", this.dateStamp());

        if (!fs.existsSync(this.inputFile)) {
            this.log("c:bgRed", "error: unable to read: " + this.inputFile);
            return false;
        }

        var stats = fs.statSync(this.inputFile);

        // Single file mode
        if (stats.isFile()) {
            readFile(this.inputFile);
        }
        // Read a directory using sync. This will lock the program until the files have been read.
        // Not such an issue for command line scripts
        else {
            files = fs.readdirSync(this.inputFile);
            files = files.filter(function (file) {
                if (file[0] != '.') {
                    return file;
                }
            });
            files.map(function (file) {
                var fileName = _this.inputFile + file;
                readFile(fileName);
            });
        }
    }

    // validate proxies using ip:port
    proxies = proxies.filter(function(proxy) {
        proxy = proxy.trim();
        if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\:[0-9]{1,5}$/.test(proxy))
            return proxy;
    });

    if (typeof this.inputFile == 'object') {
        this.log("Found ", "c:bold", proxies.length, " proxies in ", "c:bold",  this.inputFile.length, " files: ", this.inputFile.join(', '));
    }
    else {
        if (stats.isFile())
            _this.log("Found ", "c:bold", proxies.length, " proxies in ", "c:bold", this.inputFile);
        else
            _this.log("Found ", "c:bold", proxies.length, " proxies in ", "c:bold",  files.length, " files: ", files.join(', '));
    }

    var oldTotal = proxies.length;
    // now filter duplicates
    /*proxies = proxies.filter(function(proxy, index, self) {
        return index == self.indexOf(proxy);
    });*/
    // es6 way of removing dupes, taken from http://stackoverflow.com/questions/9229645/remove-duplicates-from-javascript-array
    proxies =  Array.from(new Set(proxies));

    if (oldTotal - proxies.length > 0) {
        _this.log("Removing duplicates, found ", "c:bold", (oldTotal - proxies.length), " duplicates");
    }

    this.emit('readProxies', proxies);
    return true;
};

/**
 * Saves the verified proxies to the outputFile
 */
Verify.prototype.saveProxies = function() {
    var _this = this;
    this.outputFile = String(this.outputFile).replace("{date}", this.dateStamp());
    if (fs.existsSync(this.outputFile)) {
        var origProxies = fs.readFileSync(this.outputFile).toString('utf8').split('\n');
        var oldTotal = this._verifiedProxies.length;
        this.log("Total ", "c:bold", this._verifiedProxies.length, " proxies. Appending to ",
            "c:bold", origProxies.length, " found in ", "c:bold", this.outputFile);

        this._verifiedProxies.push.apply(this._verifiedProxies, origProxies);

        oldTotal = this._verifiedProxies.length;
        // es6 way of removing dupes, taken from http://stackoverflow.com/questions/9229645/remove-duplicates-from-javascript-array
        this._verifiedProxies =  Array.from(new Set(this._verifiedProxies));

        if (oldTotal - this._verifiedProxies.length > 0) {
            _this.log("Removing ", "c:bold", (oldTotal - this._verifiedProxies.length),
                " duplicates. Grand Total ", "c:bold", this._verifiedProxies.length);
        }
    }

    let verifiedProxies = this._verifiedProxies;

    if (this.export === 'haproxy') {
      const haproxies = verifiedProxies.map(proxy => `server ${proxy} ${proxy} check`);
      const file = replaceExt(this.outputFile, '.haproxy');

      fs.writeFileSync(file, haproxies.join('\n'), 'utf8');
    }

    fs.writeFileSync(this.outputFile, verifiedProxies.join('\n'), "utf8");
    this.log("c:cyan", "Saved ", "c:cyan bold", this._verifiedProxies.length, "c:cyan", " unique proxies to ",
        "c:cyan bold", this.outputFile);
    //fs.writeFileSync(this.outputFile, this._verifiedProxies.join("\n"), "utf8");
    //fs.appendFileSync(this.outputFile, this._verifiedProxies.join("\n"), "utf8");
    //this.log("c:cyan", "Saved verified proxies to ", "c:cyan bold", this.outputFile);

    if (this.debug) {
        var date = new Date().toISOString().substring(0,19).replace('T', ' ');
        var debug = date + " Proxies: " + this._stats.total + " Good: " + this._stats.good +
        " (" +  (this._stats.good / this._stats.total * 100).toFixed(2) + "%)" +
        (this.regex ? ' Regex /' + this.regex + '/: ' + this._stats.regex : '') +
        " Avg Response: " + this._stats.avg + "s" +
        " Workers: " + this.workers + " Threads: " + this.concurrentRequests +
        " Timeout: " + this.requestTimeout + " Time: " + this.runTime() + "\n";
        this.debugLog(debug);
        this.log(debug);
    }
};


Verify.prototype.showOptions = function() {
    var _this = this;
    console.log('url: ' + this.url);
    console.log('workers: ' + this.workers);
    console.log('concurrentRequests: ' + this.concurrentRequests);
    console.log('inputFile: ' + this.inputFile);
    console.log('outputFile: ' + this.outputFile);
};

Verify.prototype.debugLog = function(msg, filename) {
    if (!filename)
        filename = __dirname + '/debug_verify.log';
    fs.appendFileSync(filename, msg);
};


/**
 * broadcastToWorkers - if an id is defined we send the payload to only that worker, otherwise it gets broadcasted to all.
 * Returns the number of messages broadcast
 * @param bool|int id
 * @param string
 * @param array|object data
 * @return int
 */
Verify.prototype.broadcastToWorkers = function(id, cmd, data){
    var count = 0;
    // send to a selected worker
    if (id && typeof cluster.workers[id] !== 'undefined') {
        cluster.workers[id].send({ cmd: cmd, data: data });
        count++;
    }
    else {
        // send to all workers
        Object.keys(cluster.workers).forEach(function(id){
            cluster.workers[id].send({cmd : cmd, data : data});
            count++;
        });
    }
    return count;
};

/**
 * broadcastToMaster sends a payload back to our master thread
 * @param array|object payload
 */
Verify.prototype.broadcastToMaster = function(cmd, data) {
    this.emit('ext'+ cmd, data);
    process.send({ cmd: cmd, data: data });
};

/**
 * Returns the date in the format DD-MM-YYYY
 * @param Date dateObj (optional)
 * @returns {string}
 */
Verify.prototype.dateStamp = function(dateObj) {
    dateObj = dateObj || new Date();
    return dateObj.toISOString().split('T')[0].split('-').reverse().join('-');
};


/**
 * I like nice looking log output
 * Little log function to take advantage of ansi colours on the CL.
 * Takes as many arguments as you want, they'll be joined together to form the log string.
 * If you want to style start an argument with c: and then your colour(s) e.g.
 * this.log('c:bgGreen bold', 'This is bold text with a green background');
 */
Verify.prototype.log = function () {
  if (this.noOutput) {
    return false;
  }

  log(Array.prototype.slice.call(arguments), this.runTime());

  return true;
};

/**
 * Returns the duration
 * @param (optional) startTime
 * @returns {string}
 */
Verify.prototype.runTime = function(startTime) {
    var millisecondDiff = new Date().getTime() - (typeof startTime !== 'undefined' ? startTime : this._startTime);

    var elapsed = {
        'days' : 0,
        'hours' : 0,
        'mins' : 0,
        'secs' : 0,
        'ms' : millisecondDiff
    };
    if (millisecondDiff > 0) {
        elapsed.ms = millisecondDiff % 1e3;
        millisecondDiff = Math.floor( millisecondDiff / 1e3 );
        elapsed.days = Math.floor( millisecondDiff / 86400 );
        millisecondDiff %= 86400;
        elapsed.hours = Math.floor ( millisecondDiff / 3600 );
        millisecondDiff %= 3600;
        elapsed.mins = Math.floor ( millisecondDiff / 60 );
        millisecondDiff %= 60;
        elapsed.secs = Math.floor( millisecondDiff  );
    }
    var showMs = true;
    var str = '';
    if (elapsed.days > 0) {
        str += chalk.bold(elapsed.days) +'d ';
        showMs = false;
    }
    if (elapsed.hours > 0) {
        str += chalk.bold(elapsed.hours) + 'h ';
        showMs = false;
    }
    if (elapsed.mins > 0) {
        str += chalk.bold(elapsed.mins) + 'm ' ;
    }
    if (( elapsed.secs > 0 && showMs ) || ( elapsed.secs === 0 && elapsed.ms > 0 ) ) {
        str += chalk.bold(elapsed.secs) + '.' + chalk.bold(String(elapsed.ms).substr(0,2)) + 's';
    }
    else if (elapsed.secs > 0) {
        str += chalk.bold(elapsed.secs) + 's';
    }
    return str;

};


Verify.prototype.userAgent = function() {
    var agents = [
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/46.0.2490.80 Safari/537.36',
        'Mozilla/5.0 (Linux; Android 4.4.2; SM-G900I Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/30.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/52.0.0.12.18;]',
        'Mozilla/5.0 (Linux; Android 4.2.2; en-za; SAMSUNG GT-I9190 Build/JDQ39) AppleWebKit/535.19 (KHTML, like Gecko) Version/1.0 Chrome/18.0.1025.308 Mobile Safari/535.19',
        'Mozilla/5.0 (Linux; Android 5.1.1; SM-N910G Build/LMY47X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/46.0.2490.76 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 4.4.2; en-za; SAMSUNG SM-G800H Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Version/1.6 Chrome/28.0.1500.94 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 4.4.2; HS-U961 Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/30.0.0.0 Mobile Safari/537.36',
        'Mozilla/5.0 (iPad; CPU OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1',
        'Mozilla/5.0 (Linux; U; Android 4.4.4; ko-kr; SHV-E210K/KTUKOB1 Build/KTU84P) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
        'Mozilla/5.0 (Linux; Android 5.0; E2303 Build/26.1.A.2.167) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.93 Mobile Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 8_4_1 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) GSA/9.0.60246 Mobile/12H321 Safari/600.1.4',
        'Opera/9.80 (Android; Opera Mini/7.5.34817/37.7011; U; en) Presto/2.12.423 Version/12.16',
        'Mozilla/5.0 (Linux; Android 5.0; SAMSUNG SM-G900I Build/LRX21T) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/34.0.1847.76 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 4.4.2; Retro Build/KOT49H) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/30.0.0.0 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; U; Android 4.1.1; en-us; SGH-T889 Build/JRO03C) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30'
    ];

    return agents[ Math.floor( Math.random() * agents.length ) ];
};

Verify.prototype.query = function(data, selector) {
  const $ = cheerio.load(data);

  return $('body').find(selector).length > 0;
}

Verify.prototype.shutdown = function shutdown (data) {
  clearTimeout(this.shutdownTimeout);
  this.broadcastToWorkers(false, 'shutdown');
  this.emit('extdone');

  this._workersFinished = 0;

  if (this._stats.good < 1) {
    this.log();
    this.log('c:red', 'No verified proxies');
    this.emit('extNothing', data);
    return false;
  }

  const sum = this._stats.responses.reduce((a, b) => {
    return a + b;
  });

  this._stats.avg = (sum / this._stats.good).toFixed(2);

  this.log();
  this.log('Processed ', 'c:bold', this._stats.total, ' proxies '
  + 'in ', 'c:bold', this.runTime());
  this.log('c:green bold', this._stats.good, 'c:green', ' proxies verified (',
      'c:green bold', (this._stats.good / this._stats.total * 100).toFixed(2)
      + '%', 'c:green', ')', 'c:green', ' Avg latency: ', 'c:green bold', this._stats.avg + 's');

  this.saveProxies();
  return false;
};

util.inherits(Verify, EventEmitter);

module.exports = Verify;
