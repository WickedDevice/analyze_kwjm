// accepts one CSV file, with a header row, as an argument
// generates a CSV file per column, using timestamp, temperature,
// and humidity from the source file

let parse = require('csv-parse');
let syncParse = require('csv-parse/lib/sync');
let stringify = require('csv-stringify');
let fs = require('fs');
let argv = require('minimist')(process.argv.slice(2));
let moment = require('moment');
let jStat = require('jStat').jStat;

let usage = () => {
  console.log(`

Usage: analyze_kwjm --i="filename.csv" --batch=3 --serial=14 [--sensitivity="sensitivity_db_filename.csv"]
`);

};

let input_filename = argv.i || "usb0.csv";
let stiffness_pole1 = argv.s || 0.18;
let stiffness_pole2 = argv.q || stiffness_pole1;
let epsilon = argv.e || 0.008;           // used by thresholding binning algorithm
let analysis_width_pct = argv.p || 0.35; // use at least this percentage of each analysis region
let slope_fit_weight  = argv.h || 0.85;  // git 85% priority to slope, 15% priority to fit
let better_slope_sig_margin = argv.m || 0.05;    // you hae to have a 5% better value to qualify as *really* better
let better_rsquared_sig_margin = argv.y || 0.05; // you hae to have a 5% better value to qualify as *really* better
let taboo_front_pct = argv.f || 0.30;    // don't allow solutions in the first 50% of the window
let taboo_tail_pct = argv.t || 0.10;     // don't allow solutions in the last 10% of the window
let min_slope_percentile = argv.r || 0.75;
let min_fit_percentile = argv.g || 0.75;
let lot_number = argv.batch || null;
let starting_serial_number = argv.serial || null;
let sensitivity_database = argv.sensitivity || null;
let minimum_optimized_duration_minutes = argv.mindur || 15;
let minimum_optimized_sample_count = argv.minsamples || 15;
const plot = !!argv.plot;
let ChartjsNode = null;
if(plot){
  ChartjsNode = require('chartjs-node');
}

const dropDateRanges = argv.drop ? argv.drop.split(",").map((v) => {
  let range = v.split("-");
  if(range.length !== 2){
    return null;
  }
  let start = moment(range[0].trim(), "MM/DD/YYYY HH:mm:ss");
  let end = moment(range[1].trim(), "MM/DD/YYYY HH:mm:ss");
  if(!start.isValid() || !end.isValid()){
    return null;
  }
  return {start, end};
}).filter(v => v !== null) : [];



if(lot_number === null || starting_serial_number === null){
  console.error("lot_number and starting_serial_number are required arguments");
  usage();
  process.exit(1);
}

lot_number = parseInt(lot_number);
starting_serial_number = parseInt(starting_serial_number);
if(isNaN(lot_number)){
  console.error("Lot number is required and must be an integer");
  usage();
  process.exit(1);
}

if(isNaN(starting_serial_number)){
  console.error("Starting serial number is required and must be an integer");
  usage();
  process.exit(1);
}

let zero_pad = (n, digits) => {
  let str = `${n}`;
  while(str.length < digits){
    str = `0${str}`;
  }
  return str;
};

let output_filename_partial = `Batch_${zero_pad(lot_number, 5)}_Serial_${zero_pad(starting_serial_number, 5)}_${zero_pad(starting_serial_number + 50 - 1, 5)}`;

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

let sensor_to_conversion_factor = {
  "NO2": 1.0e9 / 350,
  "CO": 1.0e6 / 350,
  "SO2": 1.0e9 / 350,
  "O3": 1.0e9 / 350,
};

let parts_per_suffix = {
  "NO2": "b",
  "CO": "m",
  "SO2": "b",
  "O3": "b",
  "CO2": "m",
  "VOC": "b"
};

if(sensitivity_database){
  try {
    sensitivity_database = fs.readFileSync(sensitivity_database).toString();
    sensitivity_database = syncParse(sensitivity_database, {auto_parse: true, skip_empty_lines: true});
    sensitivity_database = sensitivity_database.slice(1); // drop the header row
    sensitivity_database.forEach((val, idx) => {
      // bust open the [2] field which is the QR code data
      // extract the sensitivity (last field)
      let sensitivity = val[2].split(" ");
      let native_sensitivity = +sensitivity[sensitivity.length - 1];
      let conversion_factor = sensor_to_conversion_factor[sensitivity[sensitivity.length - 3]];
      sensitivity =  conversion_factor / (Math.abs(native_sensitivity));
      sensitivity_database[idx][2] = sensitivity;
      sensitivity_database[idx].push(native_sensitivity);
    });
    // console.log(sensitivity_database);
  }
  catch(err){
    console.log(err);
    usage();
    process.exit(1);
  }
}
else{
  sensitivity_database = [];
}

let lookupSensitivity = (lot, slot) => {
  // console.log(`Looking for lot ${lot} and slot ${slot}`);
  for(let ii = 0; ii < sensitivity_database.length; ii++){
    // console.log(sensitivity_database[ii][0], sensitivity_database[ii][3]);
    if(sensitivity_database[ii][0] === lot && sensitivity_database[ii][3] === slot){
      // console.log(`Found sensitivity ${sensitivity_database[ii][2]}`);
      return sensitivity_database[ii][2];
    }
  }
  //console.log("Not found.");
  return null;
};

let lookupNativeSensitivity = (lot, slot) => {
  // console.log(`Looking for lot ${lot} and slot ${slot}`);
  for(let ii = 0; ii < sensitivity_database.length; ii++){
    // console.log(sensitivity_database[ii][0], sensitivity_database[ii][3]);
    if(sensitivity_database[ii][0] === lot && sensitivity_database[ii][3] === slot){
      // console.log(`Found sensitivity ${sensitivity_database[ii][2]}`);
      let num_fields = sensitivity_database[ii].length;
      return sensitivity_database[ii][num_fields-1]; // last field is the native sensitivity
    }
  }
  //console.log("Not found.");
  return null;
};

let csvRef = null;

parse(input, {
  columns: (line) => {
    return line.map( v => v.toLowerCase().replace('[','_').replace(']','') );
  }
}, (err, csv) => {
  let keys = Object.keys(csv[0]);

  console.log("pre-processing drop dates");
  csv = csv.filter((r) => {
    let m = moment(r.timestamp, 'MM/DD/YYYY HH:mm:ss');

    let ok = true;
    dropDateRanges.forEach((range) => {
      if(m.isSameOrAfter(range.start) && m.isSameOrBefore(range.end)){
        ok = false;
      }
    });

    return ok;
  });
  console.log("done.");

  csvRef = csv;

  // create an array for each column
  let BLV_keys = [];
  let results = {};
  keys.forEach((key) => {
    results[key] = [];

    // while we're at it, make an individual
    // CSV file for each sensor
    if(key.indexOf("_v") >= 0){
      BLV_keys.push(key);
    }
  });

  // transpose the rows into columns
  // and coerce the results into numbers
  let sensor_type = null;
  let earliestUnixTimestamp = moment(csv[0]["timestamp"], "MM/DD/YYYY HH:mm:ss").unix();
  csv.forEach( (row) => {
    Object.keys(row).forEach((key) => {
      if (key === "timestamp"){
        results[key].push(moment(row[key], "MM/DD/YYYY HH:mm:ss").unix() - earliestUnixTimestamp);
      }
      else if(key !== "sensor_type"){
        results[key].push(+row[key]);
      }
      else{
        results[key].push(row[key]);
        sensor_type = row[key];
      }
    });
  });

  // at this point we have a vector for each sensor
  // as well as a time vector of seconds (since the first record)
  let filtered_temperature = two_pole_filter(results["temperature_degc"], stiffness_pole1, stiffness_pole2);

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
  const minimum_samples_between_edges = 20;
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
  if(falling_edges.length < rising_edges.length){
    // artificially add a falling edge to the end
    // console.log("Adding Falling Edge");
    falling_edges.push(csv.length);
  }
  else{
    // drop the last falling edge (unreachable?)
    let min_l = Math.min(rising_edges.length, falling_edges.length);
    rising_edges = rising_edges.slice(0, min_l);
    falling_edges = falling_edges.slice(0, min_l);
  }

  console.log(rising_edges, falling_edges);
  if(rising_edges.length < 5 || falling_edges.length < 5){
    console.log("warning: not enough rising / falling edges found in temperature data");
  }

  let blv_records = [];
  BLV_keys.forEach((key, idx) => {
  //let key = BLV_keys[0];
    let print = false; // (idx == 0)
    let slot_number = +key.split("_")[1];
    let target_fname = null;
    if(sensor_type){
      target_fname = `${sensor_type}_Batch_${zero_pad(lot_number, 5)}_Serial_${zero_pad(starting_serial_number + slot_number - 1, 5)}_Slot_${zero_pad(slot_number, 2)}`;
    }
    else{
      target_fname = `${input_filename.split('.')[0]}_${key}`;
    }
    let sensitivity = lookupSensitivity(lot_number, idx + 1);
    let native_sensitivity = lookupNativeSensitivity(lot_number, idx + 1);
    let blv_record = createIndividualCsv(key, csv, target_fname,
      filtered_temperature, temperature_slope, thresholded_temperature_slopes,
      results[key], rising_edges, falling_edges, sensitivity, native_sensitivity, print);
    blv_records.push(blv_record);
  });

  if(sensor_type){
    generateSummaryTableFile(`${sensor_type}_${output_filename_partial}_summary`, blv_records);
  }
  else{
    generateSummaryTableFile(`summary`, blv_records);
  }

});

let generateSummaryTableFile = (filename, records) => {
  let input = [];
  // push header
  input.push([
    "Slot #",
    "Batch #",
    "Serial #",
    "Range1_Start_Time",
    "Range1_End_Time",
    "Range1_Num_Samples",
    "Range1_Mean_Temperature",
    "Range1_Mean_Voltage",
    "Range1_Stdev_Voltage",
    "Range2_Start_Time",
    "Range2_End_Time",
    "Range2_Num_Samples",
    "Range2_Mean_Temperature",
    "Range2_Mean_Voltage",
    "Range2_Stdev_Voltage",
    "Range3_Start_Time",
    "Range3_End_Time",
    "Range3_Num_Samples",
    "Range3_Mean_Temperature",
    "Range3_Mean_Voltage",
    "Range3_Stdev_Voltage",
    "Range4_Start_Time",
    "Range4_End_Time",
    "Range4_Num_Samples",
    "Range4_Mean_Temperature",
    "Range4_Mean_Voltage",
    "Range4_Stdev_Voltage",
    "Range5_Start_Time",
    "Range5_End_Time",
    "Range5_Num_Samples",
    "Range5_Mean_Temperature",
    "Range5_Mean_Voltage",
    "Range5_Stdev_Voltage",
    "BLV_Slope_1",
    "BLV_Intercept_1",
    "BLV_Slope_2",
    "BLV_Intercept_2",
    "BLV_Slope_3",
    "BLV_Intercept_3",
    "BLV_Slope_4",
    "BLV_Intercept_4"
  ]);

  // now push all the individual rows
  records.forEach((record, idx) => {
    let entry = [
      zero_pad(idx + 1, 2),                      // slot #
      zero_pad(lot_number, 5),                   // batch #
      zero_pad(starting_serial_number + idx, 5), // serial #
    ];

    record.ranges.forEach((range) => {
      entry.push(range.start);
      entry.push(range.end);
      entry.push(range.num_samples);
      entry.push(range.mean_temperature);
      entry.push(range.mean_voltage);
      entry.push(range.stdev_voltage);
    });

    record.blvs.forEach((blv) => {
      entry.push(blv.slope);
      entry.push(blv.intercept);
    });

    input.push(entry);
  });

  stringify(input, (err, output) => {
    // write the string to file
    fs.writeFileSync(`./outputs/${filename}.csv`, output);
  });
};

let createIndividualCsv = (key, csv, filename, filt_temp, filt_temp_slope, slope_thresh, voltages, rising, falling, sensitivity, native_sensitivity, print) => {
  if(key.indexOf("_v") < 0){
    return;
  }

  console.log(`Creating ./outputs/${filename}.csv`);

  let sensor_type = csv[0]["sensor_type"] ? csv[0]["sensor_type"].toLowerCase() : null;
  if(!sensor_type){
    if(key.indexOf('no2') >= 0){
      sensor_type = 'no2';
    }
    else if(key.indexOf('co2') >= 0){
      sensor_type = 'co2';
    }
    else if(key.indexOf('co') >= 0){
      sensor_type = 'co';
    }
    else if(key.indexOf('so2') >= 0){
      sensor_type = 'so2';
    }
    else if(key.indexOf('o3') >= 0){
      sensor_type = 'o3';
    }
    else if(key.indexOf('voc') >= 0){
      sensor_type = 'voc';
    }
  }

  if(!filename){
    filename = key;
  }

  if (!fs.existsSync('./outputs')){
    fs.mkdirSync('./outputs');
  }

  // generate filtered voltage
  let filtered_voltage = two_pole_filter(voltages, stiffness_pole1, stiffness_pole2);
  let optimized_regions = optimize_regions(filtered_voltage, rising, falling, print);
  // console.log(optimized_regions);

  let debounced_thresh = expand_regions(voltages, optimized_regions.rising, optimized_regions.falling);

  let input = [];
  input.push([
    "Timestamp",
    "Temperature_degC",
    "Humidity_%",
    `${sensor_type.toUpperCase()}_V`,
    "Filtered_Temperature_degC",
    "Filtered_Temp_Slopes",
    "Thresholded_TSlopes",
    "Optimized_Thresholded_TSlopes",
    `Filtered_${sensor_type.toUpperCase()}_V`,
    `Filtered_${sensor_type.toUpperCase()}_pp${parts_per_suffix[sensor_type.toUpperCase()]}`
  ]);

  csv.forEach((row, idx) => {
    input.push([
      row["timestamp"],
      row["temperature_degc"],
      row["humidity_%"],
      row[key],
      filt_temp[idx] || 0,
      filt_temp_slope[idx] || 0,
      slope_thresh[idx] || 0,
      debounced_thresh[idx] || 0,
      filtered_voltage[idx] || 0,
      Math.abs(filtered_voltage[idx] - optimized_regions.means[0]) * sensitivity || 0
    ]);
  });

  // now that we've done all this work to establish regions of interest, its time to actually
  // calculate the BLV data, how exciting!
  let blv_data = {ranges: [], blvs: []};
  for(let ii = 0; ii < optimized_regions.rising.length; ii++){
    let idx00 = optimized_regions.rising[ii];
    let idx01 = optimized_regions.falling[ii];
    let idx10 = optimized_regions.rising[ii+1];
    let idx11 = optimized_regions.falling[ii+1];

    let mean_temperature_low = jStat.mean(filt_temp.slice(idx00, idx01));
    let mean_voltage_lowtemp = optimized_regions.means[ii];
    let stdev_voltage_lowtemp = optimized_regions.stdevs[ii];
    let num_samples_lowtemp = optimized_regions.num_samples[ii];

    let duration_minutes = moment(csv[idx01].timestamp, "MM/DD/YYYY HH:mm:ss").diff(moment(csv[idx00].timestamp, "MM/DD/YYYY HH:mm:ss"), "minutes");
    // console.log(csv[idx00].timestamp, csv[idx01].timestamp, duration_minutes, num_samples_lowtemp);
    if((num_samples_lowtemp < minimum_optimized_sample_count)
      || (duration_minutes < minimum_optimized_duration_minutes)){
      // discard this region

      if((num_samples_lowtemp < minimum_optimized_sample_count)){
        console.log(`Num samples in region ${moment(csv[idx00].timestamp, "MM/DD/YYYY HH:mm:ss").format("MM/DD/YYYY HH:mm:ss")} to ${moment(csv[idx01].timestamp, "MM/DD/YYYY HH:mm:ss").format("MM/DD/YYYY HH:mm:ss")} was ${num_samples_lowtemp} samples (min is ${minimum_optimized_sample_count} samples)`)
      }

      if(duration_minutes < minimum_optimized_duration_minutes){
        console.log(`Duration of region ${moment(csv[idx00].timestamp, "MM/DD/YYYY HH:mm:ss").format("MM/DD/YYYY HH:mm:ss")} to ${moment(csv[idx01].timestamp, "MM/DD/YYYY HH:mm:ss").format("MM/DD/YYYY HH:mm:ss")} was ${duration_minutes} minutes (min is ${minimum_optimized_duration_minutes} minutes)`)
      }

      for(let jj = idx00; jj <= idx01; jj++){
        input[jj][7] = 0;
      }
      continue;
    }

    let mean_temperature_high = null;
    let mean_voltage_hightemp = null;
    let stdev_voltage_hightemp = null;
    let num_samples_hightemp = null;

    let slope = null;
    let intercept = null;

    // if(idx10 !== undefined && idx11 !== undefined) {
    //   mean_temperature_high = jStat.mean(filt_temp.slice(idx10, idx11));
    //   mean_voltage_hightemp = optimized_regions.means[ii + 1];
    //   stdev_voltage_hightemp = optimized_regions.stdevs[ii + 1];
    //   num_samples_hightemp = optimized_regions.num_samples[ii + 1];
    //   let rise = mean_voltage_hightemp - mean_voltage_lowtemp;
    //   let run = mean_temperature_high - mean_temperature_low;
    //   slope = rise / run;
    //   intercept = mean_voltage_hightemp - slope * mean_temperature_high; // b = y - mx
    // }

    let pseudo_baseline_voltage = mean_voltage_lowtemp;
    if(blv_data.ranges.length > 0){
      pseudo_baseline_voltage = blv_data.ranges[0].mean_voltage;
    }

    blv_data.ranges.push({
      start: csv[idx00]["timestamp"],
      end: csv[idx01]["timestamp"],
      num_samples: num_samples_lowtemp,
      mean_temperature: mean_temperature_low,
      mean_voltage: mean_voltage_lowtemp,
      stdev_voltage: stdev_voltage_lowtemp,
      mean_concentration: Math.abs(pseudo_baseline_voltage - mean_voltage_lowtemp) * sensitivity,
      stdev_concentration: sensitivity * stdev_voltage_lowtemp
    });

    // if(slope !== null && intercept !== null) {
    //   blv_data.blvs.push({
    //     temperature: mean_temperature_low,
    //     slope: slope,
    //     intercept: intercept
    //   });
    //
    //   console.log(`${sensor_type}_blv add`, mean_temperature_low, slope, intercept);
    // }
  }

  // at this point we know all the ranges that were kept, and we can calculate slope / intercept forms
  blv_data.ranges.sort((a, b) => {
    return a.mean_temperature - b.mean_temperature;
  });

  for(let ii = 0; ii < blv_data.ranges.length - 1; ii++){
    let low_range = blv_data.ranges[ii];
    let high_range = blv_data.ranges[ii+1];
    let mean_voltage_lowtemp = low_range.mean_voltage;
    let mean_voltage_hightemp = high_range.mean_voltage;
    let mean_temperature_low = low_range.mean_temperature;
    let mean_temperature_high = high_range.mean_temperature;
    let rise = mean_voltage_hightemp - mean_voltage_lowtemp;
    let run = mean_temperature_high - mean_temperature_low;
    slope = rise / run;
    intercept = mean_voltage_hightemp - slope * mean_temperature_high; // b = y - mx
    blv_data.blvs.push({
      temperature: mean_temperature_low,
      slope: slope,
      intercept: intercept
    });
    console.log(`${sensor_type}_blv add`, mean_temperature_low, slope, intercept);
  }

  stringify(input, (err, output) => {
    // write the string to file
    fs.writeFileSync(`./outputs/${filename}.csv`, output);
  });

  generateIndividualBlvFile(`${filename}_blv`, sensor_type, blv_data, native_sensitivity);

  return blv_data; // return the blv data
};

let generateIndividualBlvFile = (filename, sensor_type, data, native_sensitivity) => {
  let commands = [];
  native_sensitivity = Math.abs(native_sensitivity);
  commands.push(`${sensor_type}_sen ${native_sensitivity}`);
  commands.push(`${sensor_type}_blv clear`);
  data.blvs.forEach((blv) => {
    let command = `${sensor_type}_blv add ${blv.temperature.toFixed(8)} ${blv.slope.toFixed(8)} ${blv.intercept.toFixed(8)}`;
    commands.push(command);
  });

  let obj = {
    commands: commands,
    data:  data
  };

  fs.writeFileSync(`./outputs/${filename}.json`, JSON.stringify(obj, null, 2));
  generateScatterChart(`./outputs/${filename}.png`, obj);

};

let isNumeric = (n) => {
  return !isNaN(parseFloat(n)) && isFinite(n);
};

let two_pole_filter = (vec, s1, s2) => {
  let firstNumericValue = vec.find(v => isNumeric(v));
  let firstNumericValueIdx = vec.indexOf(firstNumericValue);
  if(firstNumericValueIdx < 0){
    console.log("PANIC - no numeric values in vector");
    return;
  }

  let v_first_pole = isNumeric(vec[0]) ? vec[0] : firstNumericValue;
  let v = []; // second pole output
  let first = true;
  let lastNumericValue = 0;
  for(let ii = 0; ii < vec.length; ii++){
    if(!isNumeric(vec[ii])){
      vec[ii] = lastNumericValue; // flat interpolation
    }
    else{
      lastNumericValue = vec[ii];
    }

    if(first){
      v.push(v_first_pole);
      first = false;
    }
    else{
      v_first_pole = v_first_pole + ( vec[ii] - v_first_pole ) * s1;
      v.push( v[ii-1] + ( v_first_pole - v[ii-1] ) * s2 );
    }
  }

  return v;
};

let optimize_regions = (data, rising_idxs, falling_idxs, print) => {
  let regions = {rising: [], falling: [], means: [], stdevs: [], num_samples:[]};
  for(let ii = 0; ii < rising_idxs.length; ii++){
    let reg = optimize_region(data, rising_idxs[ii], falling_idxs[ii]);
    regions.rising.push(reg.rising);
    regions.falling.push(reg.falling);
    regions.means.push(reg.mean);
    regions.stdevs.push(reg.stdev);
    regions.num_samples.push(reg.num_samples);

    // Note: region index to print verbose for is hardcoded to 2 here
    if(print && ii == 2 ){
      console.log("========");
      let obj = getRegressionSlope(data, reg.rising, reg.falling - reg.rising + 1, true);
      console.log(JSON.stringify(obj, null, 2));
      getRSquared(data, reg.rising, reg.falling - reg.rising + 1, obj.slope, obj.intercept, true);
      console.log("========");
    }

  }
  return regions;
};

let optimize_region = (data, rising_idx, falling_idx) => {
  let region = {rising: 0, falling: 0};
  let window_length = falling_idx - rising_idx;
  let num_samples = Math.ceil(window_length * analysis_width_pct);
  let start_offset_idx = Math.floor(window_length * taboo_front_pct);
  let end_offset_idx = Math.floor(window_length * taboo_tail_pct);

  // console.log(rising_idx, start_offset_idx, csvRef[rising_idx]);
  // console.log(falling_idx, end_offset_idx, csvRef[falling_idx]);
  let startTime = moment(csvRef[rising_idx].timestamp, "MM/DD/YYYY HH:mm:ss");
  let endTime = moment(csvRef[falling_idx] ? csvRef[falling_idx].timestamp : csvRef[falling_idx-1].timestamp, "MM/DD/YYYY HH:mm:ss");
  let totalDurationMinutes = endTime.diff(startTime,"minutes");
  console.log(`Optimizing region: ${startTime.format("MM/DD/YYYY HH:mm:ss")} to ${endTime.format("MM/DD/YYYY HH:mm:ss")}, has ${window_length} samples and total duration ${totalDurationMinutes} minutes`);
  console.log(`   After truncation of taboo front and end, ${(falling_idx - end_offset_idx) - (rising_idx + start_offset_idx)} total samples remain in region`)

  let region_regressions = [];
  // calculate the regression slope for each region of width num_samples
  // (data.length - 1) - ii + 1 = num_samples
  // data.length  - ii = num_samples
  // therefore, last ii = data.length - num_samples
  let min_slope = Number.MAX_VALUE;
  let max_slope = 0;

  // start at 2 * num_samples, effectively disallowing the answer to be flush left
  for(let ii = start_offset_idx; ii <= window_length - num_samples - end_offset_idx; ii++){
    let obj = getRegressionSlope(data, rising_idx + ii, num_samples);
    if(Math.abs(obj.slope) < min_slope) min_slope = Math.abs(obj.slope);
    if(Math.abs(obj.slope) > max_slope) max_slope = Math.abs(obj.slope);

    region_regressions.push({
      idx: rising_idx + ii,
      slope: Math.abs(obj.slope),
      intercept: obj.intercept,
      mean: obj.mean,
      stdev: obj.stdev
    });
  }

  // sort the regressions
  region_regressions.sort((a, b) => {
    let a_heuristic = a.slope;
    let b_heuristic = b.slope;
    if (a_heuristic > b_heuristic && a_heuristic / b_heuristic > (1 + better_slope_sig_margin))
      return 1; // a comes later (worse) than b
    if (a_heuristic < b_heuristic && b_heuristic / a_heuristic > (1 + better_slope_sig_margin))
      return -1; // a comes earlier (better) than b

    // break ties by the rule larger idx should sort earlier
    if(a.idx > b.idx)
      return -1;
    else
      return 1;

    // technically unreachable code
    return 0;
  });

  // perform a secondary analysis on the topn results (closest to zero) slopes
  // to determine, which among them is the highest r^2 (coefficient of determination)
  let region_rsquared = [];
  let min_rsquared = 1;
  let max_rsquared = 0;

  // only consider the to ranked regressions
  for(let ii = 0; ii < Math.floor(region_regressions.length * min_slope_percentile); ii++){
    let rsquared = getRSquared(data, region_regressions[ii].idx, num_samples,
      region_regressions[ii].slope, region_regressions[ii].intercept);

    if(rsquared < min_rsquared) min_rsquared = rsquared;
    if(rsquared > max_rsquared) max_rsquared = rsquared;

    region_rsquared.push({
      idx: region_regressions[ii].idx,
      rsquared: rsquared,
      slope: region_regressions[ii].slope,
      intercept: region_regressions[ii].intercept,
      mean: region_regressions[ii].mean,
      stdev: region_regressions[ii].stdev
    });

  }

  region_rsquared.sort((a, b) => {
    let a_heuristic = a.rsquared;
    let b_heuristic = b.rsquared;

    if (a_heuristic > b_heuristic && a_heuristic / b_heuristic > (1 + better_rsquared_sig_margin))
      return -1; // a comes earlier (better) than b
    if (a_heuristic < b_heuristic && b_heuristic / a_heuristic > (1 + better_rsquared_sig_margin))
      return 1; // a comes later (worse) than b

    // break ties by the rule larger idx should sort earlier
    if(a.idx > b.idx)
      return -1;
    else
      return 1;

    // technically unreachable code
    return 0;
  });

  // for the top r-sqaured results evaluate the heuristic
  let final_results = [];
  for(let ii = 0; ii < Math.floor(region_rsquared.length * min_fit_percentile); ii++){
    final_results.push({
      idx: region_rsquared[ii].idx,
      rsquared: region_rsquared[ii].rsquared,
      slope: region_rsquared[ii].slope,
      intercept: region_rsquared[ii].intercept,
      mean: region_rsquared[ii].mean,
      stdev: region_rsquared[ii].stdev,
      heuristic: slope_fit_heuristic(
        region_rsquared[ii].slope,
        region_rsquared[ii].rsquared,
        min_slope, max_slope,
        min_rsquared, max_rsquared)
    });
  }

  // sort the results one last time
  region_rsquared.sort((a, b) => {
    let a_heuristic = a.heuristic;
    let b_heuristic = b.heuristic;

    if (a_heuristic > b_heuristic && a_heuristic / b_heuristic > (1 + better_rsquared_sig_margin))
      return -1; // a comes earlier (better) than b
    if (a_heuristic < b_heuristic && b_heuristic / a_heuristic > (1 + better_rsquared_sig_margin))
      return 1; // a comes later (worse) than b

    // break ties by the rule larger idx should sort earlier
    if(a.idx > b.idx)
      return -1;
    else
      return 1;

    // technically unreachable code
    return 0;
  });

  // declare the winner!
  region.rising = final_results[0].idx;
  region.falling = region.rising + num_samples - 1;
  region.num_samples = num_samples;
  region.rsquared = final_results[0].rsquared;
  region.slope = final_results[0].slope;
  region.intercept = final_results[0].intercept;
  region.mean = final_results[0].mean;
  region.stdev = final_results[0].stdev;
  region.heuristic = final_results[0].heuristic;

  // sanity check
  // n = (regions.rising + num_samples - 1) - regions.rising + 1
  // n = num_samples.

  console.log('done.'); //, region);

  return region;
};

let getRegressionSlope = (data, start_idx, num_samples, print) => {
  let uniform_time_vector = data.slice(start_idx, start_idx + num_samples).map((v, idx) => { return idx; });
  let other_vector = data.slice(start_idx, start_idx + num_samples);
  let n = num_samples;
  let mx = jStat.mean(uniform_time_vector);
  let my = jStat.mean(other_vector);
  let sx = jStat.stdev(uniform_time_vector, true); // sample standard dev
  let sy = jStat.stdev(other_vector, true); // sample standard dev
  let sumxy = jStat.sum(jStat([uniform_time_vector, other_vector]).product());
  let rxy = ( sumxy - ( n * mx * my ) ) / ( n * sx * sy );
  let slope = rxy * sy / sx;

  if(print){
    console.log("=== regression ===");
    console.log("uniform_time_vector: ", JSON.stringify(uniform_time_vector, null, 2));
    console.log("other_vector: ", JSON.stringify(other_vector, null, 2));
    console.log("n: ", n);
    console.log("mx: ", mx);
    console.log("my: ", my);
    console.log("sx: ", sx);
    console.log("sy: ", sy);
    console.log("sumxy: ", sumxy);
    console.log("rxy: ", rxy);
  }

  return { slope: slope, intercept: my - slope * mx, mean: my, stdev: sy };
};

let getRSquared = (data, start_idx, num_samples, slope, intercept, print) => {
  let data_vector = data.slice(start_idx, start_idx + num_samples);
  let uniform_time_vector = data_vector.map((v, idx) => { return idx; });
  let model_vector = uniform_time_vector.map((x) => {
    return slope * x + intercept;
  });

  let rho = jStat.corrcoeff(model_vector, data_vector);

  if(print){
    console.log("=== rsquared ===");
    console.log("uniform_time_vector: ", JSON.stringify(uniform_time_vector, null, 2));
    console.log("data_vector: ", JSON.stringify(data_vector, null, 2));
    console.log("model_vector: ", JSON.stringify(model_vector, null, 2));
    console.log("rho: ", rho);
    console.log("rho^2: ", rho * rho);
  }

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

let slope_fit_heuristic = (slope, fit, min_slope, max_slope, min_rsquared, max_rsquared) => {
  // values closer to min slope are better
  // values closer to max_rsquared are better

  // flip slope over, subtract off baseline, and normalize slope
  slope = remap(slope, min_slope, max_slope, 1, 0);

  // subtract off baseline and normalize rsquared
  fit = remap(fit, 0, max_rsquared, 0, 1);

  // combine normalized, baseline adjusted values into one heuristic
  return slope_fit_weight * slope + (1 - slope_fit_weight) * fit;
};

let remap = (v, input_min, input_max, output_min, output_max) => {
  let pct = (v - input_min) / (input_max - input_min);
  let out = output_min + (output_max - output_min) * pct;
  return out;
};


function generateScatterChart(filename, data){
  if(!plot) return;

  let type = data.commands[0].split("_")[0];
  // console.log(JSON.stringify(data, null, 2));
  // console.log("Type: ", type);

  let plugins = {
    beforeDraw: function (chartInstance, easing) {
        let self = chartInstance.config;    /* Configuration object containing type, data, options */
        let ctx = chartInstance.chart.ctx;  /* Canvas context used to draw with */
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, chartInstance.chart.width, chartInstance.chart.height);
    }
  };

  let datasets = [];

  let idx = data.commands.indexOf(data.commands.find(c => c.indexOf('clear') >= 0))
  let blvs = data.commands.slice(idx+1);
  // console.log(blvs);
  blvs.forEach((blv, idx) => {
    let params = blv.split(' ').slice(2).map(v => +v);
    let nextParams = blvs[idx+1] ? blvs[idx+1].split(' ').slice(2).map(v => +v) : [data.data.ranges.slice(-1)[0].x];
    let firstTemp = params[0];
    let secondTemp = nextParams[0];

    let colors = [
      'rgba(255, 0, 0, 1.0)',
      'rgba(0, 255, 0, 1.0)',
      'rgba(0, 0, 255, 1.0)',
      'rgba(255, 140, 0, 1.0)',
      'rgba(255, 0, 255, 1.0)',
      'rgba(0, 255, 255, 1.0)',
    ]

    let dataset = {
        label: `${idx}-hide`,
        data: [{
          x: firstTemp,
          y: params[1]*firstTemp + params[2]
        },{
          x: secondTemp,
          y: params[1]*secondTemp + params[2]
        }],
        backgroundColor: 'rgba(0, 0, 0, 0.0)',
        borderColor: colors[idx]
    };
    // console.log(JSON.stringify(dataset, null, 2));
    datasets.push(dataset);

    let errorBar = {
        label: `${idx}-errorbar-hide`,
        data: [{
          x: data.data.ranges[idx].mean_temperature,
          y: data.data.ranges[idx].mean_voltage + data.data.ranges[idx].stdev_voltage,
        },{
          x: data.data.ranges[idx].mean_temperature,
          y: data.data.ranges[idx].mean_voltage - data.data.ranges[idx].stdev_voltage,
        }],
        backgroundColor: 'rgba(0, 0, 0, 0.0)',
        borderColor: colors[idx]
    };
    datasets.push(errorBar);

  });

  let errorBar = {
      label: `${idx}-errorbar-hide`,
      data: [{
        x: data.data.ranges.slice(-1)[0].mean_temperature,
        y: data.data.ranges.slice(-1)[0].mean_voltage + data.data.ranges.slice(-1)[0].stdev_voltage,
      },{
        x: data.data.ranges.slice(-1)[0].mean_temperature,
        y: data.data.ranges.slice(-1)[0].mean_voltage - data.data.ranges.slice(-1)[0].stdev_voltage,
      }],
      backgroundColor: 'rgba(0, 0, 0, 0.0)',
      borderColor: 'rgba(0, 0, 0, 1.0)',
  };
  datasets.push(errorBar);


  datasets.push({
      label: `${type.toUpperCase()} BLV vs Temperature[degC]`,
      data: data.data.ranges.map((v) => {
        return {
          x: v.mean_temperature,
          y: v.mean_voltage
        }
      }),
      // backgroundColor: 'rgba(0, 0, 0, 0.0)',
      borderColor: 'rgba(0, 0, 0, 1.0)'
  });

  // 600x600 canvas size
  let chartNode = new ChartjsNode(600, 600);
  return chartNode.drawChart({
      type: 'scatter',
      data: {
          datasets
      },
      options: {
          scales: {
              xAxes: [{
                  type: 'linear',
                  position: 'bottom'
              }]
          },
          plugins,
          legend: {
            labels: {
              filter: function(legendItem, chartData) {
                // return false to hide the label
                if(legendItem.text.indexOf('hide') >= 0){
                  return false;
                }
                return true;
              }
            }
          }
      }
  })
  .then(() => {
      // chart is created

      // get image as png buffer
      return chartNode.getImageBuffer('image/png');
  })
  .then((buffer) => {
      Array.isArray(buffer) // => true
      // as a stream
      return chartNode.getImageStream('image/png');
  })
  .then((streamResult) => {
      // using the length property you can do things like
      // directly upload the image to s3 by using the
      // stream and length properties
      streamResult.stream // => Stream object
      streamResult.length // => Integer length of stream
      // write to a file
      return chartNode.writeImageToFile('image/png', `./${filename}`);
  })
  .then(() => {
    return chartNode.destroy();
  });
}

process.on('uncaughtException', (err) => {
  console.log(err);
  usage();
});
