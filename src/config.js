const debug = require('debug')('divvy');
const fs = require('fs');
const ini = require('ini');
const path = require('path');

const Utils = require('./utils');
const Constants = require('./constants');
const zookeeper = require('node-zookeeper-client');


/**
 * In support of globbing, we turn the operation value into
 * a regex. We don't want to support full regex keys (we may
 * in the future, however that will be an explicit decision).
 * These characters are escaped from globbed keys before being
 * parsed into a regex ensuring that we only support globs.
 * The tl;dr of it is that it represents special regex chars
 * excluding "*".
 */
const REGEX_ESCAPE_CHARACTERS = /[-[\]{}()+?.,\\^$|#]/g;

/**
 * Allowed pattern for the "label" field of a rule.
 */
const RULE_LABEL_REGEX = /^[a-zA-Z0-9_-]{1,255}$/;

function isGlobValue(v) {
  return v.match(/\*/);
}

/**
 * Zookeeper related settings
 */

const ZK_ENABLED_FOR_AUX_RULES = process.env.ZK_ENABLED_FOR_AUX_RULES
const ZK_HOSTS_FOR_AUX_RULES = process.env.ZK_HOSTS_FOR_AUX_RULES || 'localhost:2199';
const ZK_AUX_RULES_PATH = process.env.ZK_AUX_RULES_PATH || '/ratelimiter/rules';

class Config {
  constructor() {
    this.rules = [];
    this.ruleLabels = new Set();
  }

  /**
   * Takes a glob rule value (e.g. /my/path/*) and creates a regex to
   * test the incoming operation value with.
   * @param {string} ruleValue The glob rule value to parse to regex.
   * @return {RegExp} The regex to test the operation value with.
   */
  static parseGlob(ruleValue) {
    ruleValue = ruleValue.replace(REGEX_ESCAPE_CHARACTERS, '\\$&');
    ruleValue = ruleValue.replace('*', '.*');
    return new RegExp(`^${ruleValue}`);
  }

  createClient() {
    var client = zookeeper.createClient(ZK_HOSTS_FOR_AUX_RULES);
    const data = Buffer.from('[]')
    client.once('connected', function () {
        console.log('Connected to the zk server to listen to dynamic rules.');
    });

    client.connect();
    return client
  }

  getData(client, config) {
    const path = ZK_AUX_RULES_PATH;
    client.getData(
        path,
        function (event) {
            console.log('Got event: %s', event);
            config.getData(client, config);
        },
        function (error, data, stat) {
            if (error) {
                console.log('Error occurred when getting data: %s.', error);
                return;
            }

            console.log(
                'Node: %s has data: %s, version: %d',
                path,
                data ? data.toString() : undefined,
                stat.version
            );

            config.processNewRules(data, config)
        }
    );
  }

  processNewRules(rules, config) {
    console.log("processing new rules", rules.toString())
    console.log("file name is", process.argv[2])


    if (path.extname(process.argv[2]) == '.ini') {
      console.log("dynamic config is not supported for ini files.")
      return
    }

    const rawConfig = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));

    config.rules = [];
    config.ruleLabels = new Set();

    // push the rules read from zookeeper
    // These rules get a higher preference over the ones in the file
    // and hence pushed to the top
    (JSON.parse(rules.toString())).forEach(function (rule) {
      rawConfig.overrides.unshift(rule)
    })

    if (typeof rawConfig.default === 'object') {
      rawConfig.overrides.push(rawConfig.default);
    }

    (rawConfig.overrides || []).forEach(function (rule) {
      config.addRule({
        operation: Utils.stringifyObjectValues(rule.operation),
        creditLimit: rule.creditLimit,
        resetSeconds: rule.resetSeconds,
        actorField: rule.actorField,
        matchPolicy: rule.matchPolicy,
        label: rule.label,
        comment: rule.comment,
      });
    });

    config.validate();
  }

  static fromJsonFile(filename) {
    const rawConfig = JSON.parse(fs.readFileSync(filename, 'utf-8'));
    const config = new Config();

    if (ZK_ENABLED_FOR_AUX_RULES === 'true') {
      config.zookeeperClient = config.createClient()
      config.getData(config.zookeeperClient, config);
    }

    // Add default after other rules since it has lowest precedence
    if (typeof rawConfig.default === 'object') {
      rawConfig.overrides.push(rawConfig.default);
    }

    (rawConfig.overrides || []).forEach(function (rule) {
      config.addRule({
        operation: Utils.stringifyObjectValues(rule.operation),
        creditLimit: rule.creditLimit,
        resetSeconds: rule.resetSeconds,
        actorField: rule.actorField,
        matchPolicy: rule.matchPolicy,
        label: rule.label,
        comment: rule.comment,
      });
    });

    config.validate();
    return config;
  }

  static fromFile(filename) {
    switch (path.extname(filename)) {
      case '.json':
        return this.fromJsonFile(filename);
      case '.ini':
        return this.fromIniFile(filename);
      default:
        throw new Error(`Unrecognized format for config file: ${filename}`);
    }
  }

  /** Creates a new instance from an `ini` file.  */
  static fromIniFile(filename) {
    const rawConfig = ini.parse(fs.readFileSync(filename, 'utf-8'));
    const config = new Config();

    for (const rulegroupString of Object.keys(rawConfig)) {
      const rulegroupConfig = rawConfig[rulegroupString];

      // These fields are required and will be validated within addRule
      const operation = Config.stringToOperation(rulegroupString);
      const creditLimit = parseInt(rulegroupConfig.creditLimit, 10);
      const resetSeconds = parseInt(rulegroupConfig.resetSeconds, 10);

      // Optional fields.
      const actorField = rulegroupConfig.actorField || '';
      const matchPolicy = rulegroupConfig.matchPolicy || '';
      const comment = rulegroupConfig.comment || '';
      const label = rulegroupConfig.label || '';

      config.addRule({
        operation, creditLimit, resetSeconds, actorField, matchPolicy, label, comment,
      });
    }

    config.validate();
    return config;
  }

  /** Converts a string like `a=b c=d` to an operation like `{a: 'b', c: 'd'}`. */
  static stringToOperation(s) {
    const operation = {};
    if (s === 'default') {
      return operation;
    }
    for (const kv of s.split(/\s+/)) {
      const pair = kv.split('=');
      operation[pair[0]] = pair[1] || '';
    }
    return operation;
  }

  /**
   * Installs a new rule with least significant precendence (append).
   *
   * @param {Object} operation    The "operation" to be rate limited, specifically,
   *                              a map of free-form key-value pairs.
   * @param {number} creditLimit  Number of operations to permit every `resetSeconds`
   * @param {number} resetSeconds Credit renewal interval.
   * @param {string} actorField   Name of the actor field (optional).
   * @param {string} matchPolicy  Match policy (optional).
   * @param {string} label        Optional name for this rule.
   * @param {string} comment      Optional diagnostic name for this rule.
   */
  addRule({
    operation, creditLimit, resetSeconds, actorField, matchPolicy, label, comment,
  }) {
    if (!operation) {
      throw new Error('Operation must be specified.');
    }
    const firstFoundRule = this.findRules(operation)
      .find((rule) => rule.matchPolicy === Constants.MATCH_POLICY_STOP);

    if (firstFoundRule) {
      throw new Error(
        `Unreachable rule for operation=${operation}; masked by operation=${firstFoundRule.operation}`
      );
    }

    if (Number.isNaN(Number(creditLimit)) || creditLimit < 0) {
      throw new Error(`Invalid creditLimit for operation=${operation} (${creditLimit})`);
    }

    if (creditLimit > 0 && (Number.isNaN(Number(resetSeconds)) || resetSeconds < 1)) {
      throw new Error(`Invalid resetSeconds for operation=${operation} (${resetSeconds})`);
    }

    if (label) {
      if (!RULE_LABEL_REGEX.test(label)) {
        throw new Error(`Invalid rule label "${label}"; must match ${RULE_LABEL_REGEX}`);
      } else if (this.ruleLabels.has(label)) {
        throw new Error(`A rule with label "${label}" already exists; labels must be unique.`);
      }
      this.ruleLabels.add(label);
    }

    if (matchPolicy) {
      switch (matchPolicy) {
        case Constants.MATCH_POLICY_STOP:
        case Constants.MATCH_POLICY_CANARY:
          break;
        default:
          throw new Error(`Invalid matchPolicy "${matchPolicy}"`);
      }
    }

    const rule = {
      operation,
      creditLimit,
      resetSeconds,
      actorField: actorField || null,
      matchPolicy: matchPolicy || Constants.MATCH_POLICY_STOP,
      label: label || null,
      comment: comment || null,
    };
    this.rules.push(rule);

    debug('config: installed rule: %j', rule);
  }

  /**
   * Validate that this is a valid Config instance.
   */
  validate() {
    if (!this.rules.length) {
      throw new Error('Config does not define any rules.');
    }
    const lastRule = this.rules[this.rules.length - 1];
    if (Object.keys(lastRule.operation).length !== 0) {
      throw new Error('Config does not define a default rule.');
    }
  }

  /**
   * Finds all rules matching this operation and returns them as an array.
   *
   * In typical usage, the result will be length 1 (the request
   * matched a rule with matchPolicy "stop").
   *
   * In more advanced usages, additional "canary" rules may be returned
   * ahead of a final "stop" rule.
   */
  findRules(operation) {
    const result = [];
    for (const rule of this.rules) {
      if (!rule.matchPolicy) {
        throw new Error('Bug: Rule does not define a match policy.');
      }

      let match = true;
      for (const operationKey of Object.keys(rule.operation)) {
        const operationValue = rule.operation[operationKey];
        if (operationValue === '*') {
          match = true;
        } else if (isGlobValue(operationValue)) {
          match = Config.parseGlob(operationValue).test(operation[operationKey]);
        } else if (operationValue !== operation[operationKey]) {
          match = false;
        }

        // Skip testing additional operations if rule has already failed.
        if (!match) {
          break;
        }
      }

      if (match) {
        result.push(rule);
        if (rule.matchPolicy === Constants.MATCH_POLICY_STOP) {
          break;
        }
      }
    }

    return result;
  }

  toJson(pretty) {
    const data = {
      overrides: [],
    };
    for (const rule of this.rules) {
      if (Object.keys(rule.operation).length === 0) {
        data.default = rule;
      } else {
        data.overrides.push(rule);
      }
    }
    return JSON.stringify(data, null, pretty && 2);
  }
}

module.exports = Config;
