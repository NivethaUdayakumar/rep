import { MultiDrilldown } from './promote.js';

const md = new MultiDrilldown({
  container: '#grid',
  name: 'mainGrid',
  csv: '/data/main.csv',

  // group and color config (optional)
  groupByIdx: [0],          // group by first column
  statusIdx: 5,             // status column index
  colorColsIdx: [5],        // color based on status column

  // drill rules per main grid column index
  // defColumn[colIndex] = [ { level, event, range, fileformat, filetype, ... } ]
  defColumn: {
    2: [                    // clicking col 2 triggers level 1 drill
      {
        level: 1,
        event: 'row',
        range: '',
        fileformat: 'a0_b0_details.csv',
        filetype: 'csv'
      }
    ]
  },

  // promote config
  promoteIdx: 4,            // column with "yes" that shows promote button
  promoteCheck: [0, 1],     // cols used to form key
  promoteData: [2, 3],      // extra cols copied into payload
  promoteDataFiles: ['a0_b0_log.txt'],

  // search presets if you have them
  defaultSearches: {
    main: [
      {
        text: 'Open items',
        logic: 'AND',
        data: [
          { field: 'status', operator: 'is', value: 'OPEN' }
        ]
      }
    ]
  },

  // datatype config for MAIN grid
  // keys can be column index, field name or header text
  columnTypesMain: {
    // numeric
    score: 'float',             // operators: is, between, more, less, more equal, less equal

    // string column that should use multi select enum
    animals: 'string',          // type enum internally
                                // operators: in, not in, contains, not contains
                                // values come from distinct animals column values

    // EU datetime text column
    eu_datetime: 'eu-datetime'  // operators: is, between
  },

  // datatype config for DRILLDOWN grids
  // step 0 = level 1, step 1 = level 2 etc
  columnTypesByStep: {
    0: {
      animals: 'string',        // multi select enum with in / not in
      amount: 'float',          // numeric filters
      start_time: 'eu-datetime' // date range filters
    },
    1: {
      'Error Code': 'string'
    }
  },

  debug: true
});

// then call
md.init();
