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
let analysis_width_pct = argv.pct || 0.20; // use at least this percentage of each analysis region
let slope_fit_weight  = argv.h || 0.85; // git 85% priority to slope, 15% priority to fit
let better_margin = argv.b || 0.01; // you hae to have a .01 better heuristic value to qualify as really better

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

  console.log(rising_edges, falling_edges);
  if(rising_edges.length < 5 || falling_edges.length < 5){
    console.log("warning: not enough rising / falling edges found in temperature data");
  }

  BLV_keys.forEach((key) => {
  //let key = BLV_keys[0];
    createIndividualCsv(key, csv, null, filtered_temperature, temperature_slope, thresholded_temperature_slopes, results[key], rising_edges, falling_edges);
  });


});

let createIndividualCsv = (key, csv, filename, filt_temp, filt_temp_slope, slope_thresh, voltages, rising, falling) => {
  console.log(`Creating ./outputs/${key}.csv`);

  if(!filename){
    filename = key;
  }

  if (!fs.existsSync('./outputs')){
    fs.mkdirSync('./outputs');
  }

  // generate filtered voltage
  let filtered_voltage = two_pole_filter(voltages, stiffness_pole1, stiffness_pole2);
  let optimized_regions = optimize_regions(filtered_voltage, rising, falling);
  // console.log(optimized_regions);

  let debounced_thresh = expand_regions(voltages, optimized_regions.rising, optimized_regions.falling);

  let input = [];
  input.push([
    "Timestamp",
    "Temperature_degC",
    "Humidity_%",
    csv[0]["Sensor_Type"],
    "Filtered_Temperature_degC",
    "Filtered_Temp_Slopes",
    "Thresholded_TSlopes",
    "Optimized_Thresholded_TSlopes",
    `Filtered_${csv[0]["Sensor_Type"]}_V`
  ]);

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
};

let optimize_regions = (data, rising_idxs, falling_idxs) => {
  let regions = {rising: [], falling: []};
  for(let ii = 0; ii < rising_idxs.length; ii++){
    let reg = optimize_region(data, rising_idxs[ii], falling_idxs[ii]);
    regions.rising.push(reg.rising);
    regions.falling.push(reg.falling);
  }
  return regions;
};

let optimize_region = (data, rising_idx, falling_idx) => {
  let region = {rising: 0, falling: 0};
  let window_length = falling_idx - rising_idx;
  let num_samples = Math.ceil(window_length * analysis_width_pct);
  let half_window_length = Math.floor(window_length * 0.5);
  let region_regressions = [];
  // calculate the regression slope for each region of width num_samples
  // (data.length - 1) - ii + 1 = num_samples
  // data.length  - ii = num_samples
  // therefore, last ii = data.length - num_samples
  let min_slope = Number.MAX_VALUE;
  let max_slope = 0;

  // start at 2 * num_samples, effectively disallowing the answer to be flush left
  for(let ii = half_window_length; ii <= window_length - num_samples; ii++){
    let obj = getRegressionSlope(data, rising_idx + ii, num_samples);
    if(Math.abs(obj.slope) < min_slope) min_slope = Math.abs(obj.slope);
    if(Math.abs(obj.slope) > max_slope) max_slope = Math.abs(obj.slope);

    region_regressions.push({
      idx: rising_idx + ii,
      slope: Math.abs(obj.slope),
      intercept: obj.intercept
    });
  }

  // perform a secondary analysis on the topn results (closest to zero) slopes
  // to determine, which among them is the highest r^2 (coefficient of determination)
  let region_rsquared = [];
  let min_rsquared = 1;
  let max_rsquared = 0;
  for(let ii = 0; ii < region_regressions.length; ii++){
    let rsquared = getRSquared(data, region_regressions[ii].idx, num_samples,
      region_regressions[ii].slope, region_regressions[ii].intercept);

    if(rsquared < min_rsquared) min_rsquared = rsquared;
    if(rsquared > max_rsquared) max_rsquared = rsquared;

    region_rsquared.push({
      idx: region_regressions[ii].idx,
      rsquared: rsquared,
      slope: region_regressions[ii].slope,
      intercept: region_regressions[ii].intercept,
      heuristic: slope_fit_heuristic({
          slope: region_regressions[ii].slope,
          rsquared: rsquared,
        }, min_slope, max_slope, min_rsquared, max_rsquared)
    });

  }

  region_rsquared.sort((a, b) => {
    let a_heuristic = a.heuristic;
    let b_heuristic = b.heuristic;

    if (a_heuristic > b_heuristic && a_heuristic - b_heuristic > better_margin)
      return -1;
    if (a_heuristic < b_heuristic && b_heuristic - a_heuristic > better_margin)
      return 1;

    // break ties by the rule larger idx should sort earlier
    if(a.idx > b.idx)
      return -1;
    else
      return 1;

    // technically unreachable code
    return 0;
  });

  //console.log(JSON.stringify(region_rsquared, null, 2));

  // declare the winner!
  region.rising = region_rsquared[0].idx;
  region.falling = region.rising + num_samples - 1;
  region.rsquared = region_rsquared[0].rsquared;
  region.slope = region_rsquared[0].slope;
  region.intercept = region_rsquared[0].intercept;

  // sanity check
  // n = (regions.rising + num_samples - 1) - regions.rising + 1
  // n = num_samples.

  console.log('done.', region);

  return region;
};

let getRegressionSlope = (data, start_idx, num_samples) => {
  let uniform_time_vector = data.slice(start_idx, start_idx + num_samples).map((v, idx) => { return idx; });
  let other_vector = data.slice(start_idx, start_idx + num_samples);
  let n = num_samples;
  let mx = jStat.mean(uniform_time_vector);
  let my = jStat.mean(other_vector);
  let sx = jStat.stdev(uniform_time_vector, true); // sample standard dev
  let sy = jStat.stdev(uniform_time_vector, true); // sample standard dev
  let sumxy = jStat.sum(jStat([uniform_time_vector, other_vector]).product());
  let rxy = ( sumxy - ( n * mx * my ) ) / ( n * sx * sy );
  let slope = rxy * sy / sx;
  return { slope: slope, intercept: my - slope * mx };
};

let getRSquared = (data, start_idx, num_samples, slope, intercept) => {
  let data_vector = data.slice(start_idx, start_idx + num_samples);
  let uniform_time_vector = data_vector.map((v, idx) => { return idx; });
  let model_vector = uniform_time_vector.map((x) => {
    return slope * x + intercept;
  });

  let rho = jStat.corrcoeff(model_vector, data_vector);
  return rho * rho;
};

let expand_regions = (data, rising_idxs, falling_idxs) => {
  let vec = [];
  for(let ii = 0; ii < rising_idxs[0] - 1; ii++){
    vec.push(0);
  }
  for(let ii = 0; ii < rising_idxs.length - 1; ii++){
    while(vec.length < falling_idxs[ii] - 1){
      vec.push(1);
    }

    while(vec.length < rising_idxs[ii + 1] - 1){
      vec.push(0);
    }
  }
  while(vec.length < falling_idxs[rising_idxs.length - 1] - 1){
    vec.push(1);
  }
  while(vec.length < data.length){
    vec.push(0);
  }

  return vec;
};

let slope_fit_heuristic = (obj, min_slope, max_slope, min_rsquared, max_rsquared) => {
  let slope = obj.slope;     // values closer to min slope are better
  let fit = obj.rsquared;    // values closer to max_rsquared are better

  // flip slope over, subtract off baseline, and normalize slope
  slope = max_slope - slope; // now values closer to max slope are better
  slope -= min_slope;
  slope /= max_slope;

  // subtract off baseline and normalize rsquared
  fit -= min_rsquared;
  fit /= max_rsquared;

  // combine normalized, baseline adjusted values into one heuristic
  return slope_fit_weight * slope + (1 - slope_fit_weight) * fit;
};

process.on('uncaughtException', (err) => {
  console.log(err);
  usage();
});