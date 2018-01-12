#!/usr/bin/env node

const path = require('path');
const program = require('commander');
const Verify = require('./verify');

program
  .version('0.0.1')
  .usage('[options] <keywords>')
  .option(
    '-i, --input [input]',
    'Input file with proxies each on a new line, can be either a file or a directory containing files'
  )
  .option('-o, --output [output]', 'Output file for verified proxies.')
  .option(
    '-a, --all',
    'Shortcut to set input to be a directory, defaults to ./proxies/fetched/'
  )
  .option('-u, --url [url]', 'The url to make the requests to')
  .option('-w, --workers [workers]', 'The number of workers to use')
  .option(
    '-c, --requests [requests]',
    'The number of concurrent requests to make. Try to make it multiple of workers'
  )
  .option('-t, --timeout [timeout]', 'Timeout in ms before to kill the socket')
  .option(
    '-s, --strict',
    'Strictly enforces timeout to weed out active but slow proxies'
  )
  .option(
    '-p, --ip',
    'Uses iplookup.flashfxp.com to verify proxy isn\'t rewriting web pages'
  )
  .option('-v, --verbose', 'Show verbose output')
  .option('-d, --debug', 'Debug stores speed output to debug_verify.log')
  .option('-n, --nooutput', 'Disable all output')
  .option(
    '-r, --regex [regex]',
    'Will use regex to match body content, if matched will increment a counter displayed at the end'
  )
  .option(
    '-q, --selector [selector]',
    'Will use css selector to match body content, if not matched will return error'
  )
  .parse(process.argv);

var opts = {};

if (program.all) {
  opts.inputFile = path.join(__dirname, '/proxies/fetched/'.replace(/\//g, path.sep));
  opts.outputFile
    = path.join(__dirname, '/proxies/verified_all.txt'.replace(/\//g, path.sep));
}
if (program.input) {
  if (program.input.indexOf(',') >= - 1) {
    opts.inputFile = program.input.split(',');
  } else {
    opts.inputFile = program.input;
  }
}
if (program.output) {
  opts.outputFile = program.output;
}
if (program.url) {
  opts.url = program.url;
}
if (program.workers) {
  opts.workers = program.workers;
}
if (program.requests) {
  opts.concurrentRequests = program.requests;
}
if (program.timeout) {
  opts.requestTimeout = parseInt(program.timeout, 10);
}
//if (program.strict == 0 || program.strict == 'no' || program.strict == 'false' || program.strict == '0')
if (program.strict) {
  opts.strict = true;
}
if (program.ip) {
  opts.ip = true;
}
if (program.verbose) {
  opts.verbose = program.verbose;
}
if (program.debug) {
  opts.debug = program.debug;
}
if (program.nooutput) {
  opts.nooutput = program.nooutput;
}
if (program.regex) {
  opts.regex = program.regex;
}
if (program.selector) {
  opts.selector = program.selector;
}

var verify = new Verify(opts);

verify.main();
