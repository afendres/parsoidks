#!/usr/bin/env node
/**
 * Cluster-based Parsoid web service runner. Implements
 * https://www.mediawiki.org/wiki/Parsoid#The_Parsoid_web_API
 *
 * Local configuration:
 *
 * To configure locally, add localsettings.js to this directory and export a setup function.
 *
 * example:
 *	exports.setup = function( config, env ) {
 *		env.setInterwiki( 'localhost', 'http://localhost/wiki' );
 *	};
 *
 * Alternatively, specify a --config file explicitly. See --help for other
 * options.
 *
 * See https://www.mediawiki.org/wiki/Parsoid/Setup for more instructions.
 */
"use strict";

require('es6-shim');

var cluster = require('cluster'),
	path = require('path'),
	// process arguments
	opts = require( "yargs" )
		.usage( "Usage: $0 [-h|-v] [--param[=val]]" )
		.default({

			// Start a few more workers than there are cpus visible to the OS,
			// so that we get some degree of parallelism even on single-core
			// systems. A single long-running request would otherwise hold up
			// all concurrent short requests.
			n: require( "os" ).cpus().length + 3,
			c: __dirname + '/localsettings.js',

			v: false,
			h: false

		})
		.boolean( [ "h", "v" ] )
		.alias( "h", "help" )
		.alias( "v", "version" )
		.alias( "c", "config" )
		.alias( "n", "num-workers" ),
	argv = opts.argv;

if (cluster.isMaster && argv.n > 0) {
	var fs = require( "fs" ),
		path = require( "path" ),
		meta = require( path.join( __dirname, "../package.json" ) );

	// help
	if ( argv.h ) {
		opts.showHelp();
		process.exit( 0 );
	}

	// version
	if ( argv.v ) {
		console.log( meta.name + " " + meta.version );
		process.exit( 0 );
	}

	var timeoutHandler, timeouts = new Map();
	var spawn = function( pid ) {
		if ( pid ) {
			timeouts.delete( pid );
		}
		if ( Object.keys(cluster.workers).length < argv.n ) {
			var worker = cluster.fork();
			worker.on('message', timeoutHandler.bind(null, worker));
		}
	};

	// Kill cpu hogs
	timeoutHandler = function( worker, msg ) {
		if ( msg.type !== "timeout" ) { return; }
		if ( msg.done ) {
			clearTimeout( timeouts.get( worker.process.pid ) );
			timeouts.delete( worker.process.pid );
		} else if ( msg.timeout ) {
			var pid = worker.process.pid;
			timeouts.set(pid, setTimeout(function() {
				console.log("Cpu timeout; killing worker %s.", pid);
				worker.kill();
				spawn( pid );
			}, msg.timeout));
		}
	};

	// Fork workers.
	var worker;
	console.log('master(%s) initializing %s workers', process.pid, argv.n);
	for (var i = 0; i < argv.n; i++) {
		spawn();
	}

	cluster.on('exit', function(worker, code, signal) {
		if ( !worker.suicide ) {
			var pid = worker.process.pid;
			console.log('worker %s died (%s), restarting.', pid, code);
			spawn( pid );
		}
	});

	var shutdown_master = function() {
		console.log('master shutting down, killing workers');
		cluster.disconnect(function() {
			console.log('Exiting master');
			process.exit(0);
		});
	};

	process.on('SIGINT', shutdown_master);
	process.on('SIGTERM', shutdown_master);

} else {
	// Worker.
	process.on('SIGTERM', function() {
		console.log('Worker ' + process.pid + ' shutting down');
		process.exit(0);
	});

	// Enable heap dumps in /tmp on kill -USR2.
	// See https://github.com/bnoordhuis/node-heapdump/
	// For node 0.6/0.8: npm install heapdump@0.1.0
	// For 0.10: npm install heapdump
	process.on('SIGUSR2', function() {
		var heapdump = require('heapdump');
		console.error('SIGUSR2 received! Writing snapshot.');
		process.chdir('/tmp');
		heapdump.writeSnapshot();
	});

	var ParsoidService = require('./ParsoidService.js').ParsoidService,
		app;

	try {
		var lsp = path.resolve( process.cwd(), argv.c );
		app = new ParsoidService(require( lsp ));
	} catch ( e ) {
		console.error(e);
		// Build a skeleton localSettings to prevent errors later.
		app = new ParsoidService({setup: function ( conf ) {}});
	}
}
