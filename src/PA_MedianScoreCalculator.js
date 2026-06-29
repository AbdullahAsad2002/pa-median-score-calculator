/**
 * PA_MedianScoreCalculator
 *
 * Collects records from a source table, computes the median of a score per
 * Performance Analytics indicator, and writes results to the PA score tables.
 * Supports single breakdowns and breakdown-pair (matrix) scores, and works
 * with both the legacy pa_scores model and the new pa_scores_l1 / pa_scores_l2
 * model (selected automatically via the com.snc.pa.new_scores_tables property).
 *
 * Typical use:
 *   var calc = new PA_MedianScoreCalculator();
 *   calc.configure({ indicator: { sysId: '...' }, breakdowns: {...} });
 *   calc.collect(encodedQuery, scoreField, sourceTable);
 *   calc.writeMedians(periodStart);   // periodStart is a GlideDate
 */
var PA_MedianScoreCalculator = Class.create();
PA_MedianScoreCalculator.prototype = {

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    initialize: function () {
        this._config = null;
        this._newScoresModelCached = undefined;
        this._dateFormat = gs.getProperty('glide.sys.date_format');
        this._recordIdCache = {};
        this._breakdownPairs = [];
        this._sourceTable = null;
        this._resetBuckets();
    },

    /**
     * Prepare the calculator for one indicator run.
     * For each breakdown that supplies an elementsLoader and has no static
     * elements, the loader runs once here to populate label -> element sys_id.
     * The breakdown-pair list for the matrix is pre-computed too.
     *
     * config:
     *   indicator: { sysId }                     (required)
     *   indicatorSource: { scoreCalculator }     (optional, derived score)
     *   breakdowns: { key: { sysId, mappings, elements | elementsLoader } }
     *   collectBreakdownMatrix: boolean          (default true)
     *   breakdownMatrixExclusions: [[keyA, keyB], ...]
     */
    configure: function (config) {
        if (!config || !config.indicator || !config.indicator.sysId) {
            gs.error('PA_MedianScoreCalculator.configure: config.indicator.sysId is required.');
            return;
        }

        if (!config.breakdowns) config.breakdowns = {};

        for (var breakdownKey in config.breakdowns) {
            var breakdown = config.breakdowns[breakdownKey];
            if (!breakdown.elements) breakdown.elements = {};
            if (typeof breakdown.elementsLoader === 'function' && Object.keys(breakdown.elements).length === 0) {
                var loadedElements = breakdown.elementsLoader();
                for (var elementLabel in loadedElements) {
                    breakdown.elements[elementLabel] = loadedElements[elementLabel];
                }
            }
        }

        this._breakdownPairs = this._buildBreakdownPairs(config);
        this._config = config;
        this._resetBuckets();
    },

    /**
     * Query the source table and bucket every score three ways: overall,
     * per breakdown element, and per breakdown-pair element combination.
     */
    collect: function (encodedFilter, scoreField, sourceTable) {
        if (!this._config) {
            gs.error('PA_MedianScoreCalculator.collect: call configure() first.');
            return;
        }

        this._sourceTable = sourceTable;

        var gr = new GlideRecord(sourceTable);
        gr.addEncodedQuery(encodedFilter);
        gr.orderBy(scoreField);
        gr.query();

        var breakdowns = this._config.breakdowns;
        var breakdownPairs = this._breakdownPairs;

        while (gr.next()) {
            var score = this._readScore(gr, scoreField);
            var elementPerBreakdown = this._resolveElements(gr, breakdowns);

            this._collected.all.push(score);

            for (var breakdownKey in elementPerBreakdown) {
                var elementLabel = elementPerBreakdown[breakdownKey];
                if (!this._collected.breakdownBuckets[breakdownKey])
                    this._collected.breakdownBuckets[breakdownKey] = {};
                if (!this._collected.breakdownBuckets[breakdownKey][elementLabel])
                    this._collected.breakdownBuckets[breakdownKey][elementLabel] = [];
                this._collected.breakdownBuckets[breakdownKey][elementLabel].push(score);
            }

            for (var i = 0; i < breakdownPairs.length; i++) {
                var bdKeyA = breakdownPairs[i][0];
                var bdKeyB = breakdownPairs[i][1];
                var pairKey = bdKeyA + '|' + bdKeyB;
                var elementPairKey = elementPerBreakdown[bdKeyA] + '|' + elementPerBreakdown[bdKeyB];

                if (!this._collected.pairBuckets[pairKey])
                    this._collected.pairBuckets[pairKey] = {};
                if (!this._collected.pairBuckets[pairKey][elementPairKey])
                    this._collected.pairBuckets[pairKey][elementPairKey] = [];
                this._collected.pairBuckets[pairKey][elementPairKey].push(score);
            }
        }
    },

    /**
     * Compute the median of each bucket and write the results to the PA score
     * tables for the given period start (a GlideDate).
     */
    writeMedians: function (periodStart) {
        if (!this._config) {
            gs.error('PA_MedianScoreCalculator.writeMedians: call configure() first.');
            return;
        }

        var indicatorSysId = this._config.indicator.sysId;

        this._writeScore(indicatorSysId, '', '', '', '', this.median(this._collected.all), periodStart);

        if (Object.keys(this._config.breakdowns).length > 0) {
            this._writeBreakdownScores(indicatorSysId, periodStart);
            this._writeBreakdownPairScores(indicatorSysId, periodStart);
        }
    },

    /** Log bucket counts and medians. Useful to verify a run before writing. */
    logSummary: function () {
        var indicator = this._config ? this._config.indicator.sysId : 'not configured';
        var lines = [];

        lines.push('=== PA_MedianScoreCalculator | Indicator: ' + indicator + ' ===');
        lines.push('[ALL] count=' + this._collected.all.length +
            ' | median=' + this.median(this._collected.all));

        var buckets = this._collected.breakdownBuckets;
        for (var breakdownKey in buckets) {
            var elements = buckets[breakdownKey];
            for (var elementLabel in elements) {
                var scores = elements[elementLabel];
                lines.push('[BREAKDOWN] ' + breakdownKey + ' > ' + elementLabel +
                    ' | count=' + scores.length +
                    ' | median=' + this.median(scores));
            }
        }

        var pairs = this._collected.pairBuckets;
        for (var pairKey in pairs) {
            var elementPairs = pairs[pairKey];
            for (var elementPairKey in elementPairs) {
                var pairScores = elementPairs[elementPairKey];
                lines.push('[PAIR] ' + pairKey + ' > ' + elementPairKey +
                    ' | count=' + pairScores.length +
                    ' | median=' + this.median(pairScores));
            }
        }

        lines.push('=== END ' + indicator + ' ===');
        gs.info(lines.join('\n'));
    },

    // -------------------------------------------------------------------------
    // Public utilities
    // -------------------------------------------------------------------------

    /** Median of a numeric array, or 0 if empty. */
    median: function (scores) {
        if (!scores || scores.length === 0) return 0;

        var sorted = scores.slice().sort(function (a, b) {
            return a - b;
        });
        var count = sorted.length;

        if (count % 2 === 0) {
            return (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
        }
        return sorted[(count - 1) / 2];
    },

    /** Whole-day difference between two date/time values. Handy inside score calculators. */
    daysBetween: function (startDateTime, endDateTime) {
        var MS_PER_DAY = 86400000;
        var start = new GlideDateTime(startDateTime);
        var end = new GlideDateTime(endDateTime);
        return GlideDateTime.subtract(start, end).getNumericValue() / MS_PER_DAY;
    },

    // -------------------------------------------------------------------------
    // Private: configuration
    // -------------------------------------------------------------------------

    _buildBreakdownPairs: function (config) {
        if (config.collectBreakdownMatrix === false) return [];

        var keys = [];
        for (var k in config.breakdowns) keys.push(k);

        var exclusions = config.breakdownMatrixExclusions || [];
        var pairs = [];

        for (var i = 0; i < keys.length; i++) {
            for (var j = i + 1; j < keys.length; j++) {
                var a = keys[i];
                var b = keys[j];
                var excluded = false;

                for (var e = 0; e < exclusions.length; e++) {
                    var ex = exclusions[e];
                    if ((ex[0] === a && ex[1] === b) || (ex[0] === b && ex[1] === a)) {
                        excluded = true;
                        break;
                    }
                }

                if (!excluded) pairs.push([a, b]);
            }
        }

        return pairs;
    },

    _resetBuckets: function () {
        this._collected = {
            all: [],
            breakdownBuckets: {},
            pairBuckets: {}
        };
    },

    // -------------------------------------------------------------------------
    // Private: collection
    // -------------------------------------------------------------------------

    _readScore: function (sourceRecord, scoreField) {
        var indicatorSource = this._config.indicatorSource;
        if (indicatorSource && typeof indicatorSource.scoreCalculator === 'function') {
            return indicatorSource.scoreCalculator(sourceRecord, scoreField);
        }
        var value = parseInt(sourceRecord.getValue(scoreField), 10);
        return isNaN(value) ? 0 : value;
    },

    // Map the current record to one element label per breakdown.
    // Each breakdown supplies a mappings object keyed by source table name;
    // the mapping function receives the raw record and returns its element
    // label. Any traversal (for example to a parent record) is the mapping's
    // job. If no mapping exists for the active table, the record is bucketed
    // as __unclassified__ so scoring can continue safely.
    _resolveElements: function (queriedRecord, breakdowns) {
        var elementPerBreakdown = {};
        for (var breakdownKey in breakdowns) {
            try {
                var breakdown = breakdowns[breakdownKey];
                var mappingFn = breakdown.mappings && breakdown.mappings[this._sourceTable];

                if (typeof mappingFn === 'function') {
                    elementPerBreakdown[breakdownKey] = mappingFn(queriedRecord);
                } else {
                    gs.error('PA_MedianScoreCalculator: no mapping defined for breakdown "' +
                        breakdownKey + '" on table "' + this._sourceTable + '"');
                    elementPerBreakdown[breakdownKey] = '__unclassified__';
                }
            } catch (e) {
                gs.warn('PA_MedianScoreCalculator: mapping threw for breakdown "' +
                    breakdownKey + '" on table "' + this._sourceTable + '": ' + e);
                elementPerBreakdown[breakdownKey] = '__unclassified__';
            }
        }
        return elementPerBreakdown;
    },

    // -------------------------------------------------------------------------
    // Private: writing
    // -------------------------------------------------------------------------

    _writeScore: function (indicatorSysId, breakdownSysId, elementSysId,
        breakdown2SysId, element2SysId, scoreValue, periodStart) {
        if (isNaN(scoreValue)) scoreValue = 0;

        if (this._isNewScoresModel()) {
            if (breakdown2SysId) {
                var level1Id = this._getOrCreateLevel1Id(indicatorSysId, breakdownSysId, elementSysId, periodStart);
                if (level1Id) this._upsertLevel2Score(level1Id, breakdown2SysId, element2SysId, scoreValue);
            } else {
                this._upsertLevel1Score(indicatorSysId, breakdownSysId, elementSysId, scoreValue, periodStart);
            }
        } else {
            this._upsertLegacyScore(indicatorSysId, breakdownSysId, elementSysId,
                breakdown2SysId, element2SysId, scoreValue, periodStart);
        }
    },

    _writeBreakdownScores: function (indicatorSysId, periodStart) {
        var breakdowns = this._config.breakdowns;

        for (var breakdownKey in this._collected.breakdownBuckets) {
            var breakdown = breakdowns[breakdownKey];
            var breakdownSysId = breakdown ? breakdown.sysId : '';
            var elementBuckets = this._collected.breakdownBuckets[breakdownKey];

            for (var elementLabel in elementBuckets) {
                var scores = elementBuckets[elementLabel];
                if (!scores || scores.length === 0) continue;

                var elementSysId = (breakdown && breakdown.elements && breakdown.elements[elementLabel]) ?
                    breakdown.elements[elementLabel] : '';

                this._writeScore(indicatorSysId, breakdownSysId, elementSysId,
                    '', '', this.median(scores), periodStart);
            }
        }
    },

    _writeBreakdownPairScores: function (indicatorSysId, periodStart) {
        var breakdowns = this._config.breakdowns;
        var breakdownPairs = this._breakdownPairs;

        if (!breakdownPairs || breakdownPairs.length === 0) return;

        for (var i = 0; i < breakdownPairs.length; i++) {
            var bdKeyA = breakdownPairs[i][0];
            var bdKeyB = breakdownPairs[i][1];
            var pairKey = bdKeyA + '|' + bdKeyB;

            var pairBucket = this._collected.pairBuckets[pairKey];
            if (!pairBucket) continue;

            var breakdownA = breakdowns[bdKeyA];
            var breakdownB = breakdowns[bdKeyB];
            var bdSysIdA = breakdownA ? breakdownA.sysId : '';
            var bdSysIdB = breakdownB ? breakdownB.sysId : '';

            for (var elementPairKey in pairBucket) {
                var scores = pairBucket[elementPairKey];
                if (!scores || scores.length === 0) continue;

                var parts = elementPairKey.split('|');
                var elementLabelA = parts[0];
                var elementLabelB = parts[1];

                var elemSysIdA = (breakdownA && breakdownA.elements && breakdownA.elements[elementLabelA]) ?
                    breakdownA.elements[elementLabelA] : '';
                var elemSysIdB = (breakdownB && breakdownB.elements && breakdownB.elements[elementLabelB]) ?
                    breakdownB.elements[elementLabelB] : '';

                // PA sorts breakdown pairs by sys_id: the lower sys_id always anchors level 1.
                if (bdSysIdA <= bdSysIdB) {
                    this._writeScore(indicatorSysId,
                        bdSysIdA, elemSysIdA,
                        bdSysIdB, elemSysIdB,
                        this.median(scores), periodStart);
                } else {
                    this._writeScore(indicatorSysId,
                        bdSysIdB, elemSysIdB,
                        bdSysIdA, elemSysIdA,
                        this.median(scores), periodStart);
                }
            }
        }
    },

    _upsertLegacyScore: function (indicatorSysId, breakdownSysId, elementSysId,
        breakdown2SysId, element2SysId, scoreValue, periodStart) {
        var record = new GlideRecord('pa_scores');
        record.addQuery('indicator', indicatorSysId);
        record.addQuery('breakdown', breakdownSysId);
        record.addQuery('breakdown_level2', breakdown2SysId);
        record.addQuery('element', elementSysId);
        record.addQuery('element_level2', element2SysId);
        record.addQuery('start_at', periodStart.toString().replaceAll('-', ''));
        record.query();

        if (record.next()) {
            record.value = scoreValue;
            record.update();
        } else {
            record.initialize();
            record.indicator = indicatorSysId;
            record.breakdown = breakdownSysId;
            record.breakdown_level2 = breakdown2SysId;
            record.element = elementSysId;
            record.element_level2 = element2SysId;
            record.start_at = periodStart.getByFormat(this._dateFormat).toString();
            record.value = scoreValue;
            record.insert();
        }
    },

    _upsertLevel1Score: function (indicatorSysId, breakdownSysId, elementSysId, scoreValue, periodStart) {
        var indicatorId = this._resolveRecordId('pa_indicators', indicatorSysId);
        var breakdownId = this._resolveRecordId('pa_breakdowns', breakdownSysId);

        var record = new GlideRecord('pa_scores_l1');
        record.addQuery('indicator', indicatorId);
        record.addQuery('breakdown', breakdownId);
        record.addQuery('element', elementSysId);
        record.addQuery('start_at', periodStart.toString().replaceAll('-', ''));
        record.query();
        if (record.next()) {
            record.value = scoreValue;
            record.update();
        } else {
            record.initialize();
            record.indicator = indicatorId;
            record.breakdown = breakdownId;
            record.element = elementSysId;
            record.start_at = periodStart.getByFormat(this._dateFormat).toString();
            record.value = scoreValue;
            record.insert();
        }
    },

    _getOrCreateLevel1Id: function (indicatorSysId, breakdownSysId, elementSysId, periodStart) {
        var indicatorId = this._resolveRecordId('pa_indicators', indicatorSysId);
        var breakdownId = this._resolveRecordId('pa_breakdowns', breakdownSysId);

        var record = new GlideRecord('pa_scores_l1');
        record.addQuery('indicator', indicatorId);
        record.addQuery('breakdown', breakdownId);
        record.addQuery('element', elementSysId);
        record.addQuery('start_at', periodStart.toString().replaceAll('-', ''));
        record.query();

        if (record.next()) {
            return record.id;
        }
        record.initialize();
        record.indicator = indicatorId;
        record.breakdown = breakdownId;
        record.element = elementSysId;
        record.start_at = periodStart.getByFormat(this._dateFormat).toString();
        record.value = 0;
        record.insert();
        return record.id;
    },

    _upsertLevel2Score: function (level1Id, breakdownSysId, elementSysId, scoreValue) {
        var breakdownId = this._resolveRecordId('pa_breakdowns', breakdownSysId);

        var record = new GlideRecord('pa_scores_l2');
        record.addQuery('ref_id', level1Id.toString());
        record.addQuery('breakdown_level2', breakdownId);
        record.addQuery('element_level2', elementSysId);
        record.query();

        if (record.next()) {
            record.value = scoreValue;
            record.update();
        } else {
            record.initialize();
            record.setValue('ref_id', level1Id.toString());
            record.setValue('breakdown_level2', breakdownId);
            record.setValue('element_level2', elementSysId);
            record.setValue('value', scoreValue);
            record.insert();
        }
    },

    // -------------------------------------------------------------------------
    // Private: helpers
    // -------------------------------------------------------------------------

    _isNewScoresModel: function () {
        if (this._newScoresModelCached === undefined) {
            this._newScoresModelCached = gs.getProperty('com.snc.pa.new_scores_tables') === 'true';
        }
        return this._newScoresModelCached;
    },

    _resolveRecordId: function (table, sysId) {
        if (!sysId) return '';
        var cacheKey = table + ':' + sysId;
        if (this._recordIdCache[cacheKey] !== undefined) return this._recordIdCache[cacheKey];
        var gr = new GlideRecord(table);
        if (gr.get(sysId)) {
            this._recordIdCache[cacheKey] = gr.getValue('id');
            return this._recordIdCache[cacheKey];
        }
        gs.warn('PA_MedianScoreCalculator._resolveRecordId: no record found in ' + table + ' for sys_id ' + sysId);
        this._recordIdCache[cacheKey] = '';
        return '';
    },

    type: 'PA_MedianScoreCalculator'
};
