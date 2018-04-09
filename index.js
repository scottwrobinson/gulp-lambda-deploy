'use strict';

const assert = require('assert');
const AWS = require('aws-sdk');
const gutil = require('gulp-util');
const through = require('through2');

const DEFAULT_PARAMS = {
    handler: 'index.handler',
    runtime: 'nodejs4.3'
};

let gulpError = function(message) {
    return new gutil.PluginError('gulp-lambda-deploy', message);
};

module.exports = function(params, options) {
    if (!params) throw gulpError('No parameters provided');
    if (!params.name) throw gulpError('No Lambda function name provided');
    if (!params.role) throw gulpError('No Lambda role provided');
    if (!options) throw gulpError('No AWS options provided');
    if (!options.region) throw gulpError('No AWS region provided');
    if (!options.profile) throw gulpError('No AWS profile provided');

    if (params.s3) {
        if (!params.s3.bucket) throw gulpError('If uploading via S3, a bucket must be provided');
        if (!params.s3.key) throw gulpError('If uploading via S3, a key must be provided');
    }

    if (params.alias && !params.publish) {
        throw gulpError('An alias was provided but \'publish\' was \'false\'.');
    }

    AWS.config.credentials = new AWS.SharedIniFileCredentials({
        profile: options.profile
    });

    let s3 = new AWS.S3({
        region: options.region
    });

    let lambda = new AWS.Lambda({
        region: options.region
    });

    let transform = function(file, enc, cb) {
        if (file.isNull()) {
            return cb();
        }

        if (file.isStream()) {
            throw gulpError('Stream content is not supported');
        }

        params.file = file;
        cb();
    };

    let flush = function(cb) {
        gutil.log('Uploading Lambda function "' + params.name + '"...');

        let stream = this;
        let done = function(err) {
            if (err) return cb(gulpError(err.message));
            gutil.log('Lambda function "' + params.name + '" successfully uploaded');
            stream.push(params.file);
            cb();
        };

        if (!params.file) {
            return cb(gulpError('No code provided'));
        }

        if (params.file.path.slice(-4) !== '.zip') {
            return cb(gulpError('Given file is not a zip'));
        }

        Promise.resolve().then(function() {
            if (params.s3) {
                // Upload Lambda code via S3
                return s3upload(s3, params);
            }
        }).then(function() {
            // Check if function already exists...
            return hasLambdaFunction(lambda, params.name);
        }).then(function(hasFunction) {
            if (hasFunction) {
                // ...if it does, then update code/config...
                return updateFunctionConfiguration(lambda, params).then(function() {
                    return updateFunctionCode(lambda, params);
                });
            }
            // ...if it doesn't, then create it
            return createFunction(lambda, params);
        }).then(function(upsertedFunction) {
            if (params.alias) {
                return upsertAlias(lambda, upsertedFunction.Version, params);
            }
        }).then(function() {
            done();
        }).catch(function(err) {
            done(err);
        });
    };

    return through.obj(transform, flush);
};

function s3upload(s3, params) {
    return new Promise(function(resolve, reject) {
        var s3params = {
            Bucket: params.s3.bucket,
            Key: params.s3.key,
            Body: params.file.contents
        };

        s3.putObject(s3params, function(err, data) {
            if (err) reject(err);
            resolve(data);
        });
    });
}

function hasLambdaFunction(lambda, targetFunction) {
    return new Promise(function(resolve, reject) {
        lambda.listFunctions({}, function(err, data) {
            if (err) return reject(err);
            resolve(data.Functions);
        });
    }).then(function(functions) {
        for (let i = 0; i < functions.length; i++) {
            if (functions[i].FunctionName === targetFunction) {
                return true;
            }
        }
        return false;
    });
}

function updateFunctionCode(lambda, params) {
    // We give the 'publish' param to this method and NOT
    // 'updateFunctionConfiguration' since only this update
    // function takes Publish as a param. This should
    // always be called AFTER 'updateFunctionConfiguration'
    // so that the updated function is properly published,
    // if needed.

    var lamparams = {
        FunctionName: params.name,
        Publish: params.publish
    };

    if (params.s3) {
        lamparams.S3Bucket = params.s3.bucket;
        lamparams.S3Key = params.s3.key;
    } else {
        lamparams.ZipFile = params.file.contents;
    }

    return new Promise(function(resolve, reject) {
        lambda.updateFunctionCode(lamparams, function(err, data) {
            if (err) return reject(err);
            resolve(data);
        });
    });
}

function updateFunctionConfiguration(lambda, params) {
    var lamparams = {
        FunctionName: params.name,
        Role: params.role,
        Handler: params.handler || DEFAULT_PARAMS.handler,
        Runtime: params.runtime || DEFAULT_PARAMS.runtime
    };

    if (params.memory) {
        lamparams.MemorySize = params.memory;
    }

    if (params.description) lamparams.Description = params.description;
    if (params.timeout) lamparams.Timeout = params.timeout;

    if (params.subnets && params.securityGroups) {
        lamparams.VpcConfig = {
            SubnetIds: typeof params.subnets === 'string'? [params.subnets] : params.subnets,
            SecurityGroupIds: typeof params.securityGroups === 'string' ? [params.securityGroups] : params.securityGroups,
        };
    }

    return new Promise(function(resolve, reject) {
        lambda.updateFunctionConfiguration(lamparams, function(err, data) {
            if (err) return reject(err);
            resolve(data);
        });
    });
}

function createFunction(lambda, params) {
    let code = {};
    if (params.s3) {
        code.S3Bucket = params.s3.bucket;
        code.S3Key = params.s3.key;
    } else {
        code.ZipFile = params.file.contents;
    }

    var lamparams = {
        Code: code,
        FunctionName: params.name,
        Handler: params.handler || DEFAULT_PARAMS.handler,
        Runtime: params.runtime || DEFAULT_PARAMS.runtime,
        Role: params.role,
        Publish: params.publish
    };

    if (params.memory) {
        lamparams.MemorySize = params.memory;
    }

    if (params.description) lamparams.Description = params.description;
    if (params.timeout) lamparams.Timeout = params.timeout;

    if (params.subnets && params.securityGroups) {
        lamparams.VpcConfig = {
            SubnetIds: typeof params.subnets === 'string' ? [params.subnets] : params.subnets,
            SecurityGroupIds: typeof params.securityGroups === 'string' ? [params.securityGroups] : params.securityGroups,
        };
    }

    return new Promise(function(resolve, reject) {
        lambda.createFunction(lamparams, function(err, data) {
            if (err) return reject(err);
            resolve(data);
        });
    });
}

function getAlias(lambda, params) {
    var lamparams = {
        FunctionName: params.name,
        Name: params.alias
    };

    return new Promise(function(resolve, reject) {
        lambda.getAlias(lamparams, function(err, data) {
            if (err && err.code !== 'ResourceNotFoundException') {
                return reject(err);
            }
            resolve(data);
        });
    });
}

function createAlias(lambda, version, params) {
    var lamparams = {
        FunctionName: params.name,
        FunctionVersion: version,
        Name: params.alias
    };

    return new Promise(function(resolve, reject) {
        lambda.createAlias(lamparams, function(err, data) {
            if (err) return reject(err);
            resolve(data);
        });
    });
}

function updateAlias(lambda, version, params) {
    var lamparams = {
        FunctionName: params.name,
        FunctionVersion: version,
        Name: params.alias
    };

    return new Promise(function(resolve, reject) {
        lambda.updateAlias(lamparams, function(err, data) {
            if (err) return reject(err);
            resolve(data);
        });
    });
}

function upsertAlias(lambda, version, params) {
    var lamparams = {
        FunctionName: params.name,
        FunctionVersion: version,
        Name: params.alias
    };

    return getAlias(lambda, params).then(function(alias) {
        if (!alias) return createAlias(lambda, version, params);
        return updateAlias(lambda, version, params);
    });
}
