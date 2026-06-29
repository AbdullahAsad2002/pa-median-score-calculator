# PA Median Score Calculator

A reusable median scorer for ServiceNow Performance Analytics (PA).

Performance Analytics computes sums and averages natively, but not medians. An
average is easily distorted by a few outliers: one case that took 200 days to
close can drag a team's average resolution time far above what most people
actually experienced. The median reports the typical case, so it is often the
fairer KPI for time-based metrics.

This project queries a source table, computes the median of a score per
indicator, and writes the result straight into the PA score tables, including
single breakdowns and breakdown-pair (matrix) scores. It runs on a daily or
monthly cadence.

## Features

- Median scores written directly to the PA score tables.
- Single breakdown scores and breakdown-pair (matrix) scores.
- Daily or monthly granularity from a single switch.
- A recurring template (one period) and a backfill template (a date range).
- Works with both the legacy `pa_scores` model and the newer
  `pa_scores_l1` / `pa_scores_l2` model. The model is detected automatically
  from the `com.snc.pa.new_scores_tables` property.
- A `logSummary()` dry run so you can verify counts and medians before writing.

## Repository contents

```
.
├── README.md
├── LICENSE
├── INSTRUCTIONS.txt                  Full setup, prerequisites, and gotchas
├── src/
│   └── PA_MedianScoreCalculator.js   The Script Include
└── templates/
    ├── PA_Median_Scheduled_Template.js   Recurring run (one period)
    └── PA_Median_Backfill_Template.js    Historical run (date range)
```

## How it works

1. `configure(config)` prepares one indicator run and loads each breakdown's
   elements.
2. `collect(encodedQuery, scoreField, sourceTable)` queries the source table and
   buckets every score overall, per breakdown element, and per breakdown pair.
3. `writeMedians(periodStart)` computes the median of each bucket and upserts it
   into the PA score tables for the given period.

## Quick start

1. Create a Script Include named `PA_MedianScoreCalculator` and paste in
   `src/PA_MedianScoreCalculator.js`.
2. Copy a template (`templates/`) into a Scheduled Script Execution (recurring)
   or a Background Script (backfill).
3. Fill in your indicator sys_ids, breakdowns, source table, date field, and
   score field. Every placeholder is in `<angle brackets>` or named `your_*`.
4. Read `INSTRUCTIONS.txt` for the PA records that must exist first.

A minimal call looks like this:

```javascript
var calc = new PA_MedianScoreCalculator();

calc.configure({
    indicator: { sysId: '<indicator_sys_id>' },
    breakdowns: {
        teamBreakdown: {
            sysId: '<breakdown_sys_id>',
            mappings: {
                'your_source_table': function (record) {
                    return record.assignment_group.getDisplayValue();
                }
            },
            elementsLoader: function () {
                // return a map of element label -> element sys_id
            }
        }
    }
});

calc.collect('active=true^your_date_field>=2026-01-01 00:00:00',
             'your_score_field', 'your_source_table');

// calc.logSummary();          // optional dry run: logs counts and medians
calc.writeMedians(periodStart); // periodStart is a GlideDate
```

## Daily or monthly

Set `GRANULARITY` to `'daily'` or `'monthly'` at the top of either template.
The PA indicator's own frequency must match the cadence you run. See
`INSTRUCTIONS.txt` for the offset and range settings.

## Prerequisites

The indicator, breakdown, and breakdown element records must exist before you
run anything, and each breakdown must be associated with its indicators. The
code uses the indicator, breakdown, and element sys_ids only. Breakdown mappings
are JavaScript functions in the template (not PA mapping records), and matrix
exclusions use the breakdown keys you define. Full detail is in
`INSTRUCTIONS.txt`.

## Compatibility

ServiceNow Performance Analytics, legacy or new scores model. No plugins beyond
PA are required.

## Contributing

Issues and pull requests are welcome. If you hit an edge case with your own
schema, an issue with the table and field details is the fastest way to sort it.

## License

MIT. See `LICENSE`.
