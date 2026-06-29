/**
 * PA Median KPI - Backfill (historical) range template
 * -----------------------------------------------------------------------------
 * Paste this into a Background Script. It reprocesses a range of periods and
 * writes median KPI scores via PA_MedianScoreCalculator. Re-running a period
 * overwrites its existing scores (upsert), so backfills are safe to repeat.
 *
 * How to use:
 *   1. Set GRANULARITY to 'daily' or 'monthly'.
 *   2. Set RANGE_START and RANGE_END (inclusive). For monthly, only year+month
 *      are used; the day is ignored.
 *   3. Fill in your BREAKDOWNS, source table, date field, score field and the
 *      indicator list further down. Anything in <angle brackets> is a placeholder.
 *
 * Notes:
 *   - The PA indicator's own frequency must match GRANULARITY.
 *   - If the Script Include lives in a scoped app, prefix the constructor, e.g.
 *     new x_my_app.PA_MedianScoreCalculator().
 *   - The date window uses 00:00:00..23:59:59. Adjust the times if your PA
 *     period boundaries need a timezone offset.
 */

// =============================================================================
// SETTINGS
// =============================================================================
var GRANULARITY = 'monthly'; // 'daily' or 'monthly'
var RANGE_START = { year: 2026, month: 1, day: 1  };
var RANGE_END   = { year: 2026, month: 5, day: 31 };


// =============================================================================
// BREAKDOWN CONFIGURATION (replace with your own)
// =============================================================================
var BREAKDOWNS = {

    // Example 1: elements loaded dynamically from a table.
    teamBreakdown: {
        sysId: '<breakdown_sys_id>',
        mappings: {
            'your_source_table': function (record) {
                // Return the element label for this record. Traverse to a parent
                // first if you need to, for example:
                //   var parent = record.parent.getRefRecord();
                //   var rec = (parent && parent.isValidRecord()) ? parent : record;
                //   return rec.assignment_group.getDisplayValue();
                return record.your_reference_field.getDisplayValue();
            }
        },
        elementsLoader: function () {
            var map = {};
            var gr = new GlideRecord('your_element_table');
            gr.addEncodedQuery('your_element_filter');
            gr.query();
            while (gr.next()) {
                map[gr.getDisplayValue()] = gr.sys_id.toString();
            }
            return map;
        }
    },

    // Example 2: computed yes/no breakdown with static elements.
    fastTrackBreakdown: {
        sysId: '<breakdown_sys_id>',
        mappings: {
            'your_source_table': function (record) {
                var MS_PER_DAY = 86400000;
                var start = new GlideDateTime(record.your_start_datetime);
                var end = new GlideDateTime(record.your_end_datetime);
                var days = GlideDateTime.subtract(start, end).getNumericValue() / MS_PER_DAY;
                return days < 15 ? 'yes' : 'no';
            }
        },
        elements: {
            yes: '<element_sys_id_yes>',
            no: '<element_sys_id_no>'
        }
    }
};

var BREAKDOWN_MATRIX_EXCLUSIONS = [
    // ['teamBreakdown', 'fastTrackBreakdown']
];

var EXAMPLE_SCORE_CALCULATOR = function (record, scoreField) {
    var MS_PER_DAY = 86400000;
    var start = new GlideDateTime(record.your_start_datetime);
    var end = new GlideDateTime(record.your_end_datetime);
    return GlideDateTime.subtract(start, end).getNumericValue() / MS_PER_DAY;
};


// =============================================================================
// PERIOD HELPERS (no need to edit)
// =============================================================================
function pad(n) { return (n < 10 ? '0' : '') + n; }

function daysInMonth(month, year) {
    var d = new GlideDate();
    d.setValue(year + '-' + pad(month) + '-01');
    return d.getDaysInMonthUTC();
}

function buildPeriod(granularity, year, month, day) {
    var periodStart = new GlideDate();
    var windowStart, windowEnd;

    if (granularity === 'daily') {
        var dateStr = year + '-' + pad(month) + '-' + pad(day);
        periodStart.setValue(dateStr);
        windowStart = dateStr + ' 00:00:00';
        windowEnd = dateStr + ' 23:59:59';
    } else {
        periodStart.setValue(year + '-' + pad(month) + '-01');
        windowStart = year + '-' + pad(month) + '-01 00:00:00';
        windowEnd = year + '-' + pad(month) + '-' + pad(daysInMonth(month, year)) + ' 23:59:59';
    }

    return { periodStart: periodStart, windowStart: windowStart, windowEnd: windowEnd };
}

function dateFilter(dateField, period) {
    return dateField + '>=' + period.windowStart + '^' + dateField + '<=' + period.windowEnd;
}

function validRange() {
    if (GRANULARITY === 'monthly') {
        if (RANGE_START.month < 1 || RANGE_START.month > 12 ||
            RANGE_END.month < 1 || RANGE_END.month > 12) {
            gs.error('PA backfill: month must be between 1 and 12.');
            return false;
        }
    }
    if (RANGE_END.year < RANGE_START.year ||
        (RANGE_END.year === RANGE_START.year && RANGE_END.month < RANGE_START.month)) {
        gs.error('PA backfill: RANGE_END is before RANGE_START.');
        return false;
    }
    return true;
}

// Invokes callback(period) for every period in the configured range.
function eachPeriod(callback) {
    if (GRANULARITY === 'daily') {
        var cursor = new GlideDateTime();
        cursor.setValueUTC(RANGE_START.year + '-' + pad(RANGE_START.month) + '-' + pad(RANGE_START.day) + ' 00:00:00', 'yyyy-MM-dd HH:mm:ss');
        var last = new GlideDateTime();
        last.setValueUTC(RANGE_END.year + '-' + pad(RANGE_END.month) + '-' + pad(RANGE_END.day) + ' 00:00:00', 'yyyy-MM-dd HH:mm:ss');

        while (cursor.getNumericValue() <= last.getNumericValue()) {
            callback(buildPeriod('daily', cursor.getYearUTC(), cursor.getMonthUTC(), cursor.getDayOfMonthUTC()));
            cursor.addDaysUTC(1);
        }
    } else {
        var year = RANGE_START.year;
        var month = RANGE_START.month;
        while (year < RANGE_END.year || (year === RANGE_END.year && month <= RANGE_END.month)) {
            callback(buildPeriod('monthly', year, month, 1));
            month += 1;
            if (month > 12) { month = 1; year += 1; }
        }
    }
}

function runIndicator(indicatorSysId, breakdownsConfig, indicatorSourceConfig,
    encodedFilter, scoreField, sourceTable, periodStart) {
    // Prefix with your scope if installed in a scoped app, e.g. new x_my_app.PA_MedianScoreCalculator()
    var calc = new PA_MedianScoreCalculator();
    calc.configure({
        indicator: { sysId: indicatorSysId },
        indicatorSource: indicatorSourceConfig || {},
        breakdowns: breakdownsConfig || {},
        collectBreakdownMatrix: true,
        breakdownMatrixExclusions: BREAKDOWN_MATRIX_EXCLUSIONS
    });
    calc.collect(encodedFilter, scoreField, sourceTable);
    calc.writeMedians(periodStart);
}


// =============================================================================
// RUN
// =============================================================================
(function runBackfill() {

    if (!validRange()) return;

    eachPeriod(function (period) {

        // ---- Indicator Set A: numeric score read straight from a field ----
        var tableA = 'your_source_table';
        var fieldA = 'your_score_field';
        var baseA  = 'your_base_encoded_query' + '^' + dateFilter('your_date_field', period);

        var indicatorsA = [
            { kpiSysId: '<indicator_sys_id_1>', filter: '^your_extra_filter_1', breakdowns: true  },
            { kpiSysId: '<indicator_sys_id_2>', filter: '^your_extra_filter_2', breakdowns: false }
        ];

        for (var i = 0; i < indicatorsA.length; i++) {
            var cfg = indicatorsA[i];
            var query = baseA + cfg.filter;
            var breakdowns = cfg.breakdowns ? BREAKDOWNS : {};
            runIndicator(cfg.kpiSysId, breakdowns, {}, query, fieldA, tableA, period.periodStart);
        }

        // ---- Indicator Set B: derived score via EXAMPLE_SCORE_CALCULATOR ---
        // var tableB = 'your_other_table';
        // var fieldB = 'your_end_datetime';
        // var sourceB = { scoreCalculator: EXAMPLE_SCORE_CALCULATOR };
        // var baseB  = 'your_base_encoded_query_b' + '^' + dateFilter('your_date_field_b', period);
        //
        // var indicatorsB = [
        //     { kpiSysId: '<indicator_sys_id_3>', filter: '^your_extra_filter_3', breakdowns: true }
        // ];
        //
        // for (var j = 0; j < indicatorsB.length; j++) {
        //     var cfgB = indicatorsB[j];
        //     var queryB = baseB + cfgB.filter;
        //     var bdB = cfgB.breakdowns ? BREAKDOWNS : {};
        //     runIndicator(cfgB.kpiSysId, bdB, sourceB, queryB, fieldB, tableB, period.periodStart);
        // }

    });

})();
