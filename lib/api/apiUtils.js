'use strict';

require('../../core-upgrade.js');

var util = require('util');
var semver = require('semver');
var qs = require('querystring');
var cType = require('content-type');

var DU = require('../utils/DOMUtils.js').DOMUtils;
var Util = require('../utils/Util.js').Util;
var PegTokenizer = require('../wt2html/tokenizer.js').PegTokenizer;
var Promise = require('../utils/promise.js');
var PHPParseRequest = require('../mw/ApiRequest.js').PHPParseRequest;

/**
 * @class apiUtils
 * @singleton
 */
var apiUtils = module.exports = { };

/**
 * Send a redirect response with optional code and a relative URL
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} path
 * @param {Number} [httpStatus]
 */
apiUtils.relativeRedirect = function(res, path, httpStatus) {
	if (res.headersSent) { return; }
	var args = [path];
	if (typeof httpStatus === 'number') {
		args.unshift(httpStatus);
	}
	res.redirect.apply(res, args);
};

/**
 * Set header, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} field
 * @param {String} value
 */
apiUtils.setHeader = function(res, field, value) {
	if (res.headersSent) { return; }
	res.set(field, value);
};

/**
 * Send an html response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} body
 * @param {Number} [status] HTTP status code
 * @param {String} [contentType] A more specific type to use.
 * @param {Boolean} [omitEscape] Be explicit about omitting escaping.
 */
apiUtils.htmlResponse = function(res, body, status, contentType, omitEscape) {
	if (res.headersSent) { return; }
	if (typeof status === 'number') {
		res.status(status);
	}
	contentType = contentType || 'text/html; charset=utf-8';
	console.assert(/^text\/html;/.test(contentType));
	apiUtils.setHeader(res, 'content-type', contentType);
	// Explicit cast, since express varies response encoding by argument type
	// though that's probably offset by setting the header above
	body = String(body);
	if (!omitEscape) {
		body = Util.escapeHtml(body);
	}
	res.send(body);  // Default string encoding for send is text/html
};

/**
 * Send a plaintext response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} text
 * @param {Number} [status] HTTP status code
 * @param {String} [contentType] A more specific type to use.
 */
apiUtils.plainResponse = function(res, text, status, contentType) {
	if (res.headersSent) { return; }
	if (typeof status === 'number') {
		res.status(status);
	}
	contentType = contentType || 'text/plain; charset=utf-8';
	console.assert(/^text\/plain;/.test(contentType));
	apiUtils.setHeader(res, 'content-type', contentType);
	// Explicit cast, since express varies response encoding by argument type
	// though that's probably offset by setting the header above
	res.send(String(text));
};

/**
 * Send a JSON response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {Object} json
 * @param {Number} [status] HTTP status code
 * @param {String} [contentType] A more specific type to use.
 */
apiUtils.jsonResponse = function(res, json, status, contentType) {
	if (res.headersSent) { return; }
	if (typeof status === 'number') {
		res.status(status);
	}
	contentType = contentType || 'application/json; charset=utf-8';
	console.assert(/^application\/json;/.test(contentType));
	apiUtils.setHeader(res, 'content-type', contentType);
	res.json(json);
};

/**
 * Render response, but only if response hasn't been sent.
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} view
 * @param {Object} locals
 */
apiUtils.renderResponse = function(res, view, locals) {
	if (res.headersSent) { return; }
	res.render(view, locals);
};

/**
 * Error response
 *
 * @method
 * @param {Response} res The response object from our routing function.
 * @param {String} text
 * @param {Number} [status]
 */
apiUtils.errorResponse = function(res, text, status) {
	if (typeof status !== 'number') {
		status = 500;
	}
	var enc = res.locals.errorEnc;
	if (enc === 'json') {
		text = { error: text };
	}
	apiUtils[enc + 'Response'](res, text, status);
};

/**
 * The request timeout is a simple node timer that should fire first and catch
 * most cases where we have long running requests to optimize.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Error} err
 */
apiUtils.timeoutResp = function(env, err) {
	if (err instanceof Promise.TimeoutError) {
		err = new Error('Request timed out.');
		err.suppressLoggingStack = true;
	}
	env.log('fatal/request', err);
};

apiUtils.logTime = function(env, res, str) {
	env.log('info', util.format(
		'completed %s in %s ms', str, Date.now() - res.locals.start
	));
};

// To support the 'subst' API parameter, we need to prefix each
// top-level template with 'subst'. To make sure we do this for the
// correct templates, tokenize the starting wikitext and use that to
// detect top-level templates. Then, substitute each starting '{{' with
// '{{subst' using the template token's tsr.
apiUtils.substTopLevelTemplates = function(env, target, wt) {
	var tokenizer = new PegTokenizer(env);
	var tokens = tokenizer.tokenizeSync(wt, null, null, true);
	var tsrIncr = 0;
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].name === 'template') {
			var tsr = tokens[i].dataAttribs.tsr;
			wt = wt.substring(0, tsr[0] + tsrIncr) +
				'{{subst:' +
				wt.substring(tsr[0] + tsrIncr + 2);
			tsrIncr += 6;
		}
	}
	// Now pass it to the MediaWiki API with onlypst set so that it
	// subst's the templates.
	return PHPParseRequest.promise(env, target, wt, true);
};

apiUtils.wikitextContentType = function(env) {
	return 'text/plain; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/wikitext/' + env.wikitextVersion + '"';
};

apiUtils.htmlContentType = function(env, contentVersion) {
	return 'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/' + (contentVersion || env.contentVersion) + '"';
};

apiUtils.pagebundleContentType = function(env, contentVersion) {
	return 'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/pagebundle/' + (contentVersion || env.contentVersion) + '"';
};

apiUtils.dataParsoidContentType = function(env) {
	return 'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/' + env.contentVersion + '"';
};

apiUtils.dataMwContentType = function(env) {
	return 'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/data-mw/' + env.contentVersion + '"';
};

/**
 * Extracts a pagebundle from a revision.
 *
 * @method
 * @param revision
 * @return {Object}
 */
apiUtils.extractPageBundle = function(revision) {
	return {
		parsoid: revision['data-parsoid'] && revision['data-parsoid'].body,
		mw: revision['data-mw'] && revision['data-mw'].body,
	};
};

/**
 * Validates the pagebundle was provided in the expected format.
 *
 * @method
 * @param {Object} pb
 * @param {String} originalVersion
 */
apiUtils.validatePageBundle = function(pb, originalVersion) {
	var err;
	if (!pb.parsoid || pb.parsoid.constructor !== Object || !pb.parsoid.ids) {
		err = new Error('Invalid data-parsoid was provided.');
		err.httpStatus = 400;
		err.suppressLoggingStack = true;
		throw err;
	}
	if (semver.satisfies(originalVersion, '^2.0.0') &&
			(!pb.mw || pb.mw.constructor !== Object || !pb.mw.ids)) {
		err = new Error('Invalid data-mw was provided.');
		err.httpStatus = 400;
		err.suppressLoggingStack = true;
		throw err;
	}
};

/**
 * Log a fatal/request.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {String} text
 * @param {Number} [httpStatus]
 */
apiUtils.fatalRequest = function(env, text, httpStatus) {
	var err = new Error(text);
	err.httpStatus = httpStatus || 404;
	err.suppressLoggingStack = true;
	env.log('fatal/request', err);
};

/**
 * Determine the content version from the html's content type.
 *
 * @param {Object} html
 * @return {String|null}
 */
apiUtils.versionFromType = function(html) {
	var ct = html.headers && html.headers['content-type'];
	if (ct) {
		try {
			var t = cType.parse(ct);
			var profile = t.parameters && t.parameters.profile;
			if (profile) {
				var p = apiUtils.parseProfile(profile, 'html');
				return p && p.version;
			} else {
				return null;
			}
		} catch (e) {
			return null;
		}
	} else {
		return null;
	}
};

var oldSpec = /^mediawiki.org\/specs\/(html)\/(\d+\.\d+\.\d+)$/;
var newSpec = /^https:\/\/www.mediawiki.org\/wiki\/Specs\/(HTML|pagebundle)\/(\d+\.\d+\.\d+)$/;

/**
 * Used to extract the format and content version from a profile.
 *
 * @method
 * @param {String} profile
 * @param {String} format
 *   Just used for backwards compatibility w/ <= 1.2.0
 *   where the pagebundle didn't have a spec.
 * @return {Object|null}
 */
apiUtils.parseProfile = function(profile, format) {
	var match = newSpec.exec(profile);
	// TODO(arlolra): Remove when this version is no longer supported.
	if (!match) {
		match = oldSpec.exec(profile);
		if (match) { match[1] = format; }
	}
	if (match) {
		return {
			format: match[1].toLowerCase(),
			version: match[2],
		};
	} else {
		return null;
	}
};

/**
 * Set the content version to an acceptable version.
 * Returns false if Parsoid is unable to supply one.
 *
 * @method
 * @param {Response} res
 * @param {Array} acceptableTypes
 * @return {Boolean}
 */
apiUtils.validateAndSetContentVersion = function(res, acceptableTypes) {
	var env = res.locals.env;
	var opts = res.locals.opts;

	// `acceptableTypes` is already sorted by quality.
	return !acceptableTypes.length || acceptableTypes.some(function(t) {
		var profile = t.parameters && t.parameters.profile;
		if ((opts.format === 'html' && t.type === 'text/html') ||
				(opts.format === 'pagebundle' && t.type === 'application/json') ||
				// 'pagebundle' is sending 'text/html' in older versions
				oldSpec.exec(profile)) {
			if (profile) {
				var p = apiUtils.parseProfile(profile, opts.format);
				if (p && (opts.format === p.format)) {
					var contentVersion = env.resolveContentVersion(p.version);
					if (contentVersion !== null) {
						env.setContentVersion(contentVersion);
						return true;
					} else {
						return false;
					}
				} else {
					return false;
				}
			} else {
				return true;
			}
		} else if (t.type === '*/*' ||
				(opts.format === 'html' && t.type === 'text/*')) {
			return true;
		} else {
			return false;
		}
	});
};

apiUtils._redirect = function(req, res, target, processRedirect) {
	var locals = res.locals;
	var path = processRedirect([
		'',
		locals.env.conf.parsoid.mwApiMap.get(locals.iwp).domain,
		'v3',
		'page',
		locals.opts.format,
		encodeURIComponent(target),
	].join('/'));

	// Don't cache redirect requests
	apiUtils.setHeader(res, 'Cache-Control', 'private,no-cache,s-maxage=0');
	apiUtils.relativeRedirect(res, path);
};

/**
 * @method
 * @param {Request} req
 * @param {Response} res
 */
apiUtils.redirectToOldid = function(req, res) {
	var env = res.locals.env;
	return this._redirect(
		req,
		res,
		env.normalizeAndResolvePageTitle(),
		function(redirPath) {
			var revid = env.page.meta.revision.revid;
			redirPath += '/' + revid;
			if (Object.keys(req.query).length > 0) {
				redirPath += '?' + qs.stringify(req.query);
			}
			var format = res.locals.opts.format;
			env.log('info', 'redirecting to revision', revid, 'for', format);
			var metrics = env.conf.parsoid.metrics;
			if (metrics) {
				metrics.increment('redirectToOldid.' + format.toLowerCase());
			}
			return redirPath;
		}
	);

};

/**
 * @method
 * @param {String} title
 * @param {Request} req
 * @param {Response} res
 */
apiUtils._redirectToPage = function(title, req, res) {
	return this._redirect(
		req,
		res,
		title,
		function(path) {
			res.locals.env.log('info', 'redirecting to ', path);
			return path;
		}
	);
};

/**
 * Downgrade content from 2.x to 1.x
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Object} revision
 * @param {Response} res
 * @param {String} [contentmodel]
 */
apiUtils.downgrade2to1 = function(env, revision, res, contentmodel) {
	var doc = DU.parseHTML(revision.html.body);
	var pb = apiUtils.extractPageBundle(revision);
	apiUtils.validatePageBundle(pb, env.originalVersion);
	// Effectively, skip applying data-parsoid.  Note that if we were to
	// support a pb2html downgrade, we'd need to apply the full thing,
	// but that would create complications where ids would be left behind.
	// See the comment in around `DU.applyPageBundle`
	DU.applyPageBundle(doc, { parsoid: { ids: {} }, mw: pb.mw });
	// No need to `DU.extractDpAndSerialize`, it wasn't applied.
	var html = DU.toXML(res.locals.bodyOnly ? doc.body : doc, {
		innerXML: res.locals.bodyOnly,
	});
	apiUtils.wt2htmlRes(env, res, html, pb, contentmodel);
};

/**
 * Update red links on a document.
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Object} revision
 * @param {Response} res
 * @param {String} [contentmodel]
 */
apiUtils.updateRedLinks = function(env, revision, res, contentmodel) {
	var doc = DU.parseHTML(revision.html.body);
	var pb = apiUtils.extractPageBundle(revision);
	apiUtils.validatePageBundle(pb, env.originalVersion);
	return DU.addRedLinks(env, doc)
	.then(function() {
		// No need to `DU.extractDpAndSerialize`, it wasn't applied.
		var html = DU.toXML(res.locals.bodyOnly ? doc.body : doc, {
			innerXML: res.locals.bodyOnly,
		});
		apiUtils.wt2htmlRes(env, res, html, pb, contentmodel);
	});
};

/**
 * Send an appropriate response with the right content types for wt2html
 *
 * @method
 * @param {MWParserEnvironment} env
 * @param {Object} res
 * @param {String} html
 * @param {Object} pb
 * @param {String} [contentmodel]
 */
apiUtils.wt2htmlRes = function(env, res, html, pb, contentmodel) {
	if (pb) {
		var response = {
			contentmodel: contentmodel,
			html: {
				headers: { 'content-type': apiUtils.htmlContentType(env) },
				body: html,
			},
			'data-parsoid': {
				headers: { 'content-type': apiUtils.dataParsoidContentType(env) },
				body: pb.parsoid,
			},
		};
		if (semver.satisfies(env.contentVersion, '^2.0.0')) {
			response['data-mw'] = {
				headers: { 'content-type': apiUtils.dataMwContentType(env) },
				body: pb.mw,
			};
		}
		apiUtils.jsonResponse(res, response, undefined, apiUtils.pagebundleContentType(env));
	} else {
		apiUtils.htmlResponse(res, html, undefined, apiUtils.htmlContentType(env), true);
	}
};

apiUtils.shouldScrub = function(req, def) {
	// Check hasOwnProperty to avoid overwriting the default when
	// this isn't set.  `scrubWikitext` was renamed in RESTBase to
	// `scrub_wikitext`.  Support both for backwards compatibility,
	// but prefer the newer form.
	if (req.body.hasOwnProperty('scrub_wikitext')) {
		return !(!req.body.scrub_wikitext || req.body.scrub_wikitext === 'false');
	} else if (req.query.hasOwnProperty('scrub_wikitext')) {
		return !(!req.query.scrub_wikitext || req.query.scrub_wikitext === 'false');
	} else if (req.body.hasOwnProperty('scrubWikitext')) {
		return !(!req.body.scrubWikitext || req.body.scrubWikitext === 'false');
	} else if (req.query.hasOwnProperty('scrubWikitext')) {
		return !(!req.query.scrubWikitext || req.query.scrubWikitext === 'false');
	} else {
		return def;
	}
};
