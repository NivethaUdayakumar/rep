import { MultiDrilldown } from './multiDrilldown.js';

const mdd = new MultiDrilldown({
  container: '#grid',
  name: 'Main',
  csv: 'data/table.csv',
  groupByIdx: [0, 1],        // group on first 2 columns
  statusIdx: [11],           // color by status (running/completed/failed)
  promoteIdx: 10,            // column that contains yes/no; shows "promote" button when yes
  promoteCheck: [4],      // build key from these cols; joined with "_" (use single idx for no "_")
  promoteData: [13, 14, 15, 16, 17, 18],  // store these cols (header->value) into data/summary.json

  // Drilldown (per-clicked-column rules)
  // For column 13 in MAIN:
  //   step1 => CSV using main row tokens a0..aN
  //   step2 => CSV using both main (a*) and clicked row in level-1 (b*)
  //   step3 => CSV using main (a*), level-1 (b*), level-2 (c*)
  defColumn: {
    13: [
      'data/dropdown/a0_a1_a2_a3_a4_a5_a6.csv',
      'data/dropdown/a0_a1_a2_a3_a4_a5_a6_b0_b1_b2_b3_b4.csv'
    ],

    // Column 14 opens an HTML dashboard (single step)
    14: ['data/html/chart.html'],

    // Column 15 mixes CSV then HTML
    15: [
      'data/dropdown/a0_a1_a2_a3_a4_a5_a6.csv',
      'data/dropdown/a0_a1_a2_a3_a4_a5_a6_b0_b1_b2_b3_b4.csv',
      'data/html/chart.html'
    ],

    // Column 6: two-step CSV drilldown
    6: [
      'data/dropdown/a0_a1_a2_a3_a4_a5_a6.csv',
      'data/dropdown/a0_a1_a2_a3_a4_a5_a6_b0_b1_b2_b3_b4.csv'
    ]
  },

  // Misc
  debug: true
});

mdd.init();
