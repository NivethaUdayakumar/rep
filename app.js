/*import { TableBuilder } from './tableBuilder.js';

new TableBuilder({
  dataCsv: '/data/table.csv',
  fileCsv: null, // omit or set null for non-clickable grid
  box: '#grid',
  name: 'myGrid',
  groupByIdx: [1,2],  // optional
  statusIdx: 11,       // optional
  colorColsIdx: [11]   // optional
}).build();*/

/*
  import { Drilldown } from './tableDrilldown.js';

  // Build MAIN table; clicking any cell in columns 14..19 opens Level-B
  const dd = new Drilldown({
    mainCsv: './data/table.csv',
    container: '#grid',
    selectableCols: [14,15,16,17,18,19], // 1-based
    mainKeyCols: [1,2,3,4,5,6,7], // 1-based
    bKeyCols: [1,2,3,4,5], // 1-based
    childDir: './data/dropdown',
    fallbackToFirstBRow: false,
    sep: '_',               // where B/C CSVs live
    groupByIdx: [0,1,2],                     
    statusIdx: 11,
    colorColsIdx: [11],
    debug: true
  });
  dd.init();*/

import { MultiDrilldown } from "./multiDrilldown.js";/*
  const dd4 = new MultiDrilldown({
  levels: [
    { name:'Main', csv:'./data/table.csv', selectableCols:[10,11,12], keyCols:[1,2,3,4,5,6,7], groupByIdx: [0,1,2], dir:'./data/dropdown' },
    { name:'B',    childKeyCols:[1,2,3,4,5], dir:'./data/dropdown' },
    { name:'C',    childKeyCols:[1,2,3,4,5], dir:'./data/dropdown' },
    { name:'D',     dir:'./data/deep-data' }
  ],
  container:'#grid',
  name:'mainGrid',
  sep:'_',
  fallbackToFirstRow:true, 
  debug:true
});
dd4.init();*/

const mdd = new MultiDrilldown({
  container: '#grid',
  name: 'MainTracker',
  csv: './data/table.csv',
  // Table options
  groupByIdx: [0, 1],         // group rows by first two columns
  statusIdx: [11],            // color by status column
  promoteIdx: [12],           // promote button column
  promoteCheck: [4, 5],       // key built from col4 and col5
  promoteData: [13,14,15,16], // values to save in summary.json
  // Drilldown definitions
  defColumn: {
    13: [
      './data/dropdown/a0_a1_a2_a3_a4_a5_a6.csv', // first popup
      './data/dropdown/a0_a1_a2_a3_a4_a5_a6_b0_b1_b2_b3_b4.csv'             // second popup
    ],
    14: [
      './data/html/chart.html'                      // directly open html content
    ],
    6: [
      './data/dropdown/a0_a1_a2_a3_a4_a5_a6.csv', // first popup
      './data/dropdown/a0_a1_a2_a3_a4_a5_a6_b0_b1_b2_b3_b4.csv'             // second popup
    ]
  },
  debug: true
});
mdd.init();