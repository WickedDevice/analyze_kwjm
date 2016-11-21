// accepts one CSV file, with a header row, as an argument
// generates a CSV file per column, using timestamp, temperature,
// and humidity from the source file

let parse = require('csv-parse');
let stringify = require('csv-stringify');
let fs = require('fs');
let argv = require('minimist')(process.argv.slice(2));
let moment = require('moment');
let jStat = require('jStat').jStat;

let usage = () => {
  console.log(`
Usage: analyze_kwjm --i="filename.csv"
`);

};

let input_filename = argv.i || "usb0.csv";
let stiffness_pole1 = argv.s1 || 0.05;
let stiffness_pole2 = argv.s2 || stiffness_pole1;
let epsilon = argv.eps || 0.008;
let leading_discard_fraction = argv.ld || 0.50;
let trailing_discard_fraction = argv.td || 0.20;

// check to see if the input file exists and if not exit with an error message and usage
let input = null;
try {
  input = fs.readFileSync(input_filename);
}
catch(err){
  console.log(err);
  usage();
  process.exit(1);
}

parse(input, {columns: true}, (err, csv) => {
  let keys = Object.keys(csv[0]);

  // create an array for each column
  let BLV_keys = [];
  let results = {};
  keys.forEach((key) => {
    results[key] = [];

    // while we're at it, make an individual
    // CSV file for each sensor
    if(key.indexOf("Slot") >= 0){
      BLV_keys.push(key);
    }
  });

  // transpose the rows into columns
  // and coerce the results into numbers
  let earliestUnixTimestamp = moment(csv[0]["Timestamp"], "MM/DD/YYYY HH:mm:ss").unix();
  csv.forEach( (row) => {
    Object.keys(row).forEach((key) => {
      if (key === "Timestamp"){
        results[key].push(moment(row[key], "MM/DD/YYYY HH:mm:ss").unix() - earliestUnixTimestamp);
      }
      else if(key !== "Sensor_Type"){
        results[key].push(+row[key]);
      }
      else{
        results[key].push(row[key]);
      }
    });
  });

  // at this point we have a vector for each sensor
  // as well as a time vector of seconds (since the first record)
  let filtered_temperature = two_pole_filter(results["Temperature_degC"], stiffness_pole1, stiffness_pole2);

  // then apply a difference filter on the result
  let temperature_slope = two_pole_filter(jStat.diff(filtered_temperature), stiffness_pole1, stiffness_pole2);

  // then threshold the result
  let thresholded_temperature_slopes = temperature_slope.map((val) => {
    return val > -epsilon && val < +epsilon ? 1 : 0;
  });

  // there should be 5 segments of contiguous 1 values
  // after the threshold operation
  // find the indices of each rising and falling edges
  let rising_edges = [];
  let falling_edges = [];
  let level_state = thresholded_temperature_slopes[0];
  let last_edge_idx = 0;
  const minimum_samples_between_edges = 50;
  // let debounced_thresholding = [];
  thresholded_temperature_slopes = thresholded_temperature_slopes.map((val, idx) => {
    let new_val = level_state;
    if(val !== level_state){
      if(idx - last_edge_idx > minimum_samples_between_edges) {
        if (val == 0) {
          falling_edges.push(idx + 1);
          new_val = 0;
        }
        else {
          rising_edges.push(idx + 1);
          new_val = 1;
        }
        level_state = val;
        last_edge_idx = idx;
      }
      else{
        // otherwise ignore it as a spurious transition
        console.log("warning: ignoring spurious transition at idx " + idx);
      }
    }
    return new_val;
    // debounced_thresholding.push(level_state);
  });

  // make sure the index of the first falling edge is after the first detected rising edge
  while(rising_edges[0] >= falling_edges[0] && falling_edges.length > 0){
    falling_edges = falling_edges.slice(1);
  }

  // make those two vectors the same length
  let min_l = Math.min(rising_edges.length, falling_edges.length);
  rising_edges = rising_edges.slice(0, min_l);
  falling_edges = falling_edges.slice(0, min_l);

  // clean the debounced thresholding array up by:
  // (1) setting value to zero up to the first rising edge
  // (2) moving each rising edge forward half the distance to it's corresponding falling edge
  // (3) backing off each falling edge by 5% of the window

  for(let ii = 0; ii < falling_edges.length; ii++){
    let num_samples = falling_edges[ii] - rising_edges[ii];
    let new_rising_edge = Math.floor(rising_edges[ii] + (leading_discard_fraction * num_samples));
    let new_falling_edge = Math.floor(falling_edges[ii] - trailing_discard_fraction * num_samples);

    console.log(`${num_samples} : ${rising_edges[ii]} -> ${falling_edges[ii]}, ${new_rising_edge} -> ${new_falling_edge} `);

    if(new_rising_edge > new_falling_edge){
      console.log(`failure: major problem, nothing left after removing leading and trailing segments from segment ${rising_edges[ii]} ... ${falling_edges[ii]}`)
    }
    else{
      rising_edges[ii] = new_rising_edge;
      falling_edges[ii] = new_falling_edge;
    }
  }

  // expand the edge events into a vector
  let debounced_thresholding = [];
  for(let ii = 0; ii < rising_edges[0] - 1; ii++){
    debounced_thresholding.push(0);
  }
  for(let ii = 0; ii < rising_edges.length - 1; ii++){
    while(debounced_thresholding.length < falling_edges[ii] - 1){
      debounced_thresholding.push(1);
    }

    while(debounced_thresholding.length < rising_edges[ii + 1] - 1){
      debounced_thresholding.push(0);
    }
  }
  while(debounced_thresholding.length < falling_edges[rising_edges.length - 1] - 1){
    debounced_thresholding.push(1);
  }
  while(debounced_thresholding.length < thresholded_temperature_slopes.length){
    debounced_thresholding.push(0);
  }


  console.log(rising_edges, falling_edges);

  BLV_keys.forEach((key) => {
    createIndividualCsv(key, csv, null, filtered_temperature, temperature_slope, thresholded_temperature_slopes, debounced_thresholding, results[key]);
  });

  // take a pre-defined portion of each rising -> falling period
  // as a BLV analysis period, and expect 5 periods
  if(rising_edges.length < 5 || falling_edges.length < 5){
    console.log("warning: not enough rising / falling edges found in temperature data");
  }

  for(let ii = 0; ii < 5; ii++){
    console.log(`BLV Analyzing period ${rising_edges[ii]} ... ${falling_edges[ii]} \t= ${falling_edges[ii] - rising_edges[ii]} samples`);
    // establish average temperature for this period
    let avg_t = jStat.mean(results["Temperature_degC"].slice(rising_edges[ii], falling_edges[ii]));
    let std_t = jStat.stdev(results["Temperature_degC"].slice(rising_edges[ii], falling_edges[ii]));
    BLV_keys.forEach((key) => {
      // establish the average and stdev voltage for each slot
      let avg_v = jStat.mean(results[key].slice(rising_edges[ii], falling_edges[ii]));
      let std_v = jStat.stdev(results[key].slice(rising_edges[ii], falling_edges[ii]));
      // console.log(`${key}`, avg_t, std_t, avg_v, std_v);
    });
  }

  // having determined the average temperature and voltage for each slot in each blv period
  // calculate the slope and intercepts for the blv commands

});

let createIndividualCsv = (key, csv, filename, filt_temp, filt_temp_slope, slope_thresh, debounced_thresh, voltages) => {
  console.log(`Creating ./outputs/${key}.csv`);

  if(!filename){
    filename = key;
  }

  if (!fs.existsSync('./outputs')){
    fs.mkdirSync('./outputs');
  }

  let input = [];
  input.push([
    "Timestamp",
    "Temperature_degC",
    "Humidity_%",
    csv[0]["Sensor_Type"],
    "Filtered_Temperature_degC",
    "Filtered_Temp_Slopes",
    "Thresholded_TSlopes",
    "Debounced_Thresholded_TSlopes",
    `Filtered_${csv[0]["Sensor_Type"]}_V`
  ]);

  // generate filtered voltage
  let filtered_voltage = two_pole_filter(voltages, stiffness_pole1, stiffness_pole2);

  csv.forEach((row, idx) => {
    input.push([
      row["Timestamp"],
      row["Temperature_degC"],
      row["Humidity_%"],
      row[key],
      filt_temp[idx] || 0,
      filt_temp_slope[idx] || 0,
      slope_thresh[idx] || 0,
      debounced_thresh[idx] || 0,
      filtered_voltage[idx] || 0
    ]);
  });

  stringify(input, (err, output) => {
    // write the string to file
    fs.writeFileSync(`./outputs/${filename}.csv`, output);
  });
};

let two_pole_filter = (vec, s1, s2) => {
  let v_first_pole = vec[0];
  let v = []; // second pole output

  for(let ii = 0; ii < vec.length; ii++){
    if(ii == 0){
      v.push(v_first_pole );
    }
    else{
      v_first_pole = v_first_pole + ( vec[ii] - v_first_pole ) * s1;
      v.push( v[ii-1] + ( v_first_pole - v[ii-1] ) * s2 );
    }
  }

  return v;
}

process.on('uncaughtException', (err) => {
  console.log(err);
  usage();
});