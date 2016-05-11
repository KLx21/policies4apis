'use strict';

const _ = require('lodash');
const oBoom = require('boom');
const oFs = require('fs');
const oHoek = require('hoek');
const oItems = require('items');
const oPath = require('path');

const aApplicablePoints = [
    'onRequest',
    'onPreAuth',
    'onPostAuth',
    'onPreHandler',
    'onPostHandler',
    'onPreResponse'
];

var oData = {
    names: [],
    rawPolicies: {},
    setHandlers: {}
};
var aHandlers = {};
// Memoizes by converting ['policy1', ..., 'policyN'] to 'policy1,...,policyN' as key
var determineAggregateApplyPoint = _.memoize((aPolicyNames) => {

    oHoek.assert(_.isArray(aPolicyNames), 'Requires array of policy names.');
    oHoek.assert(!_.isEmpty(aPolicyNames), 'Requires non-empty array of policy names.');
    oHoek.assert(_.intersection(oData.names, aPolicyNames).length ===
            aPolicyNames.length, 'Requires loaded policy names.');

    var sFirstPolicy = aPolicyNames[0];
    var applyPoint;

    for (var i = 0; i < aApplicablePoints.length; ++i) {

        // Check if the first policy appears to have this apply point.
        if (!applyPoint &&
                Object.keys(oData[aApplicablePoints[i]]).indexOf(sFirstPolicy) !== -1) {

            applyPoint = aApplicablePoints[i];
        }
    }

    oHoek.assert(applyPoint, 'Policies must be in a valid applyPoint.');
    oHoek.assert(_.intersection(Object.keys(oData[applyPoint]), aPolicyNames).length === aPolicyNames.length,
            'Aggregate policies must be from same applyPoint.');

    return applyPoint;
});

/* adding arrays, to hold the policies */
aApplicablePoints.forEach((oApplyPoint) => {

    oData[oApplyPoint] = {};
});

/* generate handlers, one handler for each application point */
aApplicablePoints.forEach((oApplyPoint) => {

    aHandlers[oApplyPoint] = (oReq, fReply) => {

        var aApplyPointPolicies = oData[oApplyPoint];
        var aRoutePolicies = oHoek.reach(oReq, 'route.settings.plugins.policies');

        if (!aRoutePolicies) {

            return fReply.continue();
        }

        var bRepliedWithError = false;
        var aPoliciesToRun = aRoutePolicies.reduce((aTmpList, xRoutePolicy) => {

            // Already replied
            if (bRepliedWithError) {
                return;
            }

            // Transform array to parallel, determine apply point in advance
            var aAggregateApplyPoint;

            if (Array.isArray(xRoutePolicy)) {

                aAggregateApplyPoint = determineAggregateApplyPoint(xRoutePolicy);

                if (aAggregateApplyPoint === oApplyPoint) {

                    xRoutePolicy = exports.parallel.apply(this, xRoutePolicy);

                } else {

                    xRoutePolicy = null;
                }
            }

            if (_.isString(xRoutePolicy)) {

                // Look for missing policies.  Probably due to misspelling.
                if (_.includes(oData.names, xRoutePolicy)) {

                    bRepliedWithError = true;

                    return fReply(oBoom.notImplemented('Missing policy: ' + xRoutePolicy));
                }

                if (aApplyPointPolicies[xRoutePolicy]) {

                    aTmpList.push(aApplyPointPolicies[xRoutePolicy]);
                }

            } else if (_.isFunction(xRoutePolicy)) {

                // If an aggregate apply point wasn't already determined
                // but an aggregate apply point seems like it will be used, determine it from `policy.runs`.
                // `policy.runs` is an array of loaded policies reported by an aggregate policy
                // such as MrHorse.parallel, specifically for determining
                // its apply point ad hoc, notably here in the extension handler.
                if (!aAggregateApplyPoint && xRoutePolicy.runs && !xRoutePolicy.applyPoint) {

                    aAggregateApplyPoint = determineAggregateApplyPoint(xRoutePolicy.runs);
                }

                if (!hasValidApplyPoint(xRoutePolicy)) {

                    bRepliedWithError = true;

                    return fReply(oBoom.badImplementation('Trying to use incorrect applyPoint for the dynamic policy: ' +
                            xRoutePolicy.applyPoint));
                }

                var effectiveApplyPoint =
                        xRoutePolicy.applyPoint ||
                        aAggregateApplyPoint ||
                        oReq.server.plugins.mrhorse.defaultApplyPoint;

                if (effectiveApplyPoint === oApplyPoint) {

                    aTmpList.push(xRoutePolicy);
                }

            } else if (!_.isNull(xRoutePolicy)) {

                bRepliedWithError = true;

                return fReply(oBoom.badImplementation('Policy not specified by name or by function.'));
            }

            return aTmpList;
        }, []);

        // Already replied
        if (bRepliedWithError) {

            return;
        }

        runPolicies(aPoliciesToRun, oReq, fReply);
    };
});

function hasValidApplyPoint(oPolicy) {

    return !oPolicy.applyPoint || _.includes(aApplicablePoints, oPolicy.applyPoint);
}

function runPolicies(policiesToRun, request, reply) {

    function checkPolicy(policy, next) {

        policy(request, reply, (err, canContinue, message) => {

            if (err) {
                // You can provide a custom hapi error object here
                return next(err);
            }
            if (canContinue) {
                return next(null, true);
            }
            return next(oBoom.forbidden(message));
        });
    }

    // Run the policies in order
    oItems.serial(policiesToRun, checkPolicy, (err) => {

        if (!reply._replied) {
            if (err) {
                return reply(err);
            }

            reply.continue();
        }
    });
}

function loadPolicies(server, options, next) {

    var match = null;
    const re = /(.+)\.js$/;

    options.defaultApplyPoint = options.defaultApplyPoint || 'onPreHandler'; // default application point

    const policyFiles = oFs.readdirSync(options.policyDirectory);
    if (policyFiles.length === 0) {
        return next();
    }

    function addPolicy(filename, addPolicyNext) {

        // Only looking for .js files in the policies folder
        match = filename.match(re);
        if (match) {
            // Does this policy already exist
            if (oData.names.indexOf(match[1]) !== -1) {
                server.log(['error'], 'Trying to add a duplicate policy: ' + match[1]);
                return addPolicyNext(new Error('Trying to add a duplicate policy: ' + match[1]));
            }

            // Add this policy function to the data object
            const policy = require(oPath.join(options.policyDirectory, filename));

            // Check if the apply point is correct
            if (!hasValidApplyPoint(policy)) {
                server.log(['error'], 'Trying to set incorrect applyPoint for the policy: ' + policy.applyPoint);
                return addPolicyNext(new Error('Trying to set incorrect applyPoint for the policy: ' +
                        policy.applyPoint));
            }

            // going further, filling the policies vs application points list
            if (policy.applyPoint === undefined || policy.applyPoint) {
                const applyPoint = policy.applyPoint || options.defaultApplyPoint;

                server.log(['info'], 'Adding a new policy called ' + match[1]);
                oData[applyPoint][match[1]] = policy;
                oData.rawPolicies[match[1]] = policy;
                oData.names.push(match[1]);

                // connect the handler if this is the first pre policy
                if (!oData.setHandlers[applyPoint]) {
                    server.ext(applyPoint, aHandlers[applyPoint]);
                    oData.setHandlers[applyPoint] = true;
                }
            }
        }

        addPolicyNext();
    }

    oItems.serial(policyFiles, addPolicy, (err) => {

        next(err);
    });
}

function reset() {

    oData = {
        names: [],
        rawPolicies: {},
        setHandlers: {}
    };

    /* clear memoize cache */
    determineAggregateApplyPoint.cache.clear();

    /* adding arrays to hold the policies */
    aApplicablePoints.forEach((applyPoint) => {

        oData[applyPoint] = {};
    });
}

exports.register = function register(server, options, next) {

    options.defaultApplyPoint = options.defaultApplyPoint || 'onPreHandler'; // default application point

    oHoek.assert(aApplicablePoints.indexOf(options.defaultApplyPoint) !== -1, 'Specified invalid defaultApplyPoint: ' +
            options.defaultApplyPoint);

    server.expose('loadPolicies', loadPolicies);
    server.expose('data', oData);
    server.expose('reset', reset);
    server.expose('defaultApplyPoint', options.defaultApplyPoint);

    if (options.policyDirectory !== undefined) {
        loadPolicies(server, options, (err) => {

            next(err);
        });
    }
    else {
        next();
    }
};

exports.register.attributes = {
    pkg: require('../package.json')
};

/* Policy aggregation tools */
exports.parallel = function (/*policy1, policy2, [cb]*/) {

    oHoek.assert(arguments.length, 'Requires at least one argument.');

    const args = Array.prototype.slice.call(arguments);

    // This error aggregator is used by default, giving priority to error responses
    // by the policies' listed order.
    function defaultErrorHandler(ranPolicies, results, next) {

        _.forEach(ranPolicies, (oPolicy) => {

            var result = results[oPolicy];

            if (result.err || !result.canContinue) {

                next(result.err, result.canContinue, result.message);
                return false;
            }
        });

        next(null, true);
    }

    // Determine the error handler and policies we're using
    var errorHandler;
    var policyNames;
    if (typeof args[args.length - 1] === 'function') {

        errorHandler = args[args.length - 1];
        policyNames = args.slice(0, -1);
    }
    else {

        errorHandler = defaultErrorHandler;
        policyNames = args;
    }

    oHoek.assert(_.uniq(policyNames).length === policyNames.length, 'Listed policies must be unique.');

    // Wraps policy for use in Items.parallel.execute, never errors.
    function wrapPolicy (policy, request, reply) {

        return (next) => {

            policy(request, reply, (err, canContinue, message) => {

                next(null, {
                    err: err,
                    canContinue: canContinue,
                    message: message
                });
            });
        };
    }

    // Aggregate policy
    function aggregatePolicy(request, reply, next) {

        var policies = _(oData.rawPolicies)
                .pick(policyNames)
                .mapValues((policy) => {

                    return wrapPolicy(policy, request, reply);
                }).value();

        oItems.parallel.execute(policies, (err, results) => {

            oHoek.assert(!err, 'There should never be an error here because of wrapPolicy.');

            errorHandler(policyNames, results, next);
        });
    }

    // Report to MrHorse handler which policies are going to be run
    aggregatePolicy.runs = policyNames;

    // Here ya go!
    return aggregatePolicy;
};
