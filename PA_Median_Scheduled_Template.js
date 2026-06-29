/**
 * PA Median KPI - Scheduled (recurring) run template
 * -----------------------------------------------------------------------------
 * Paste this into a Scheduled Script Execution (or a Background Script to test).
 * It computes median KPI scores for ONE period and writes them via
 * PA_MedianScoreCalculator.
 *
 * How to use:
 *   1. Set GRANULARITY to 'daily' or 'monthly'.
 *   2. For daily, set DAY_OFFSET (0 = today, -1 = yesterday).
 *      For monthly, set MONTH_OFFSET (0 = this month, -1 = last month).
 *   3. Fill in your BREAKDOWNS, source table, date field, score field and the
 *      indicator list further down. Anything in <angle brackets> is a placeholder.
 *
 * Notes:
 *   - The PA indicator's own frequency must match GRANULARITY (a daily indicator
 *     for daily runs, a monthly indicator for monthly runs).
 *   - If the Script Include lives in a scoped app, prefix the constructor, e.g.
 *     new x_my_app.PA_MedianScoreCalculator().
 *   - The date window below uses 00:00:00..23:59:59. Adjust the times if your PA
 *     period boundaries need a timezone offset.
 */

// =============================================================================
// SETTINGS
// =============================================================================
var GRANULARITY  = 'monthly'; // 'daily' or 'monthly'
var DAY_OFFSET   = 0;         // used when GRANULARITY === 'daily'   (0=today, -1=yesterday)
var MONTH_OFFSET = 0;         // used when GRANULARITY === 'monthly' (0=this month, -1=last month)


// =============================================================================
// BREAKDOWN CONFIGURATION (replace with your own)
// Each breakdown defines:
//   sysId       - the pa_breakdowns sys_id
//   mappings    - one function per source table; returns the element LABEL for a record
//   elements    - static label -> element sys_id, OR
//   elementsLoader - a function that builds label -> element sys_id once at configure()
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

// Breakdown pairs to skip in the matrix (order independent).
var BREAKDOWN_MATRIX_EXCLUSIONS = [
    // ['teamBreakdown', 'fastTrackBreakdown']
];

// Optional: derive a score instead of reading a numeric field directly.
// Return a number; it is collected like any other score.
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

// Returns { periodStart: GlideDate, windowStart: 'yyyy-MM-dd HH:mm:ss', windowEnd: '...' }
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

// Encoded-query fragment that limits a date field to the period window.
function dateFilter(dateField, period) {
    return dateField + '>=' + period.windowStart + '^' + dateField + '<=' + period.windowEnd;
}

// The single period this scheduled run represents.
function currentPeriod() {
    var now = new GlideDateTime();

    if (GRANULARITY === 'daily') {
        var anchor = new GlideDateTime(now);
        anchor.addDaysUTC(DAY_OFFSET);
        return buildPeriod('daily', anchor.getYearUTC(), anchor.getMonthUTC(), anchor.getDayOfMonthUTC());
    }

    var month = now.getMonthUTC() + MONTH_OFFSET;
    var year = parseInt(now.getYearUTC(), 10);
    while (month < 1)  { month += 12; year -= 1; }
    while (month > 12) { month -= 12; year += 1; }
    return buildPeriod('monthly', year, month, 1);
}

// Runs one indicator end to end.
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
(function runScheduled() {

    var period = currentPeriod();

    // ---- Indicator Set A: numeric score read straight from a field ---------
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

    // ---- Indicator Set B: derived score via EXAMPLE_SCORE_CALCULATOR --------
    // Uncomment and adapt if some indicators need a computed score.
    //
    // var tableB = 'your_other_table';
    // var fieldB = 'your_end_datetime';                 // any field; the calculator ignores it
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

})();
