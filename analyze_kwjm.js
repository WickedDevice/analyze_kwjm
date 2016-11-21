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
Usage: analyze_kwjm --i=filename.csv
`);

};

let input_filename = argv.i || "usb0.csv";

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
      createIndividualCsv(key, csv);
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

  // first filter the temperatures using with a fixed window of 100 samples
  const depth = 100;
  let v = [];
  for(let ii = 0; ii < results["Temperature_degC"].length; ii++){
    if(ii == 0){
      v.push(results["Temperature_degC"][0]);
    }
    else if(ii < depth){
      v.push((results["Temperature_degC"][ii] + (v[ii-1] * ii) ) / (ii + 1) );
    }
    else{
      v.push(v[ii-1]
        + ( results["Temperature_degC"][ii] / depth )
        - ( results["Temperature_degC"][ii - depth] / depth ) );
    }
  }

  // then apply a difference filter on the result
  v = jStat.diff(v);

  // then threshold the result
  const epsilon = 0.01;
  v = v.map((val) => {
    return val > -epsilon && val < +epsilon ? 1 : 0;
  });

  // there should be 5 segments of contiguous 1 values
  // after the threshold operation
  // find the indices of each rising and falling edges
  let rising_edges = [];
  let falling_edges = [];
  let level_state = v[0];
  let last_edge_idx = 0;
  const minimum_samples_between_edges = 100;
  v.forEach((val, idx) => {
    if(val !== level_state){
      if(idx - last_edge_idx > minimum_samples_between_edges) {
        if (val == 0) {
          falling_edges.push(idx);
        }
        else {
          rising_edges.push(idx);
        }
        level_state = val;
        last_edge_idx = idx;
      }
      else{
        // otherwise ignore it as a spurious transition
        console.log("warning: ignoring spurious transition at idx " + idx);
      }

    }
  });

  // take a pre-defined portion of each rising -> falling period
  // as a BLV analysis period, and expect 5 periods
  if(rising_edges.length < 5 || falling_edges.length < 5){
    console.log("warning: not enough rising / falling edges found in temperature data");
  }

  for(let ii = 0; ii < 5; ii++){
    console.log(`BLV Analyzing period ${rising_edges[ii]} .. ${falling_edges[ii]}`);
    // establish average temperature for this period
    let avg_t = jStat.mean(results["Temperature_degC"].slice(rising_edges[ii], falling_edges[ii]));
    let std_t = jStat.stdev(results["Temperature_degC"].slice(rising_edges[ii], falling_edges[ii]));
    BLV_keys.forEach((key) => {
      // establish the average and stdev voltage for each slot
      let avg_v = jStat.mean(results[key].slice(rising_edges[ii], falling_edges[ii]));
      let std_v = jStat.stdev(results[key].slice(rising_edges[ii], falling_edges[ii]));
      console.log(`${key}`, avg_t, std_t, avg_v, std_v);
    });
  }

  // having determined the average temperature and voltage for each slot in each blv period
  // calculate the slope and intercepts for the blv commands


});

let createIndividualCsv = (key, csv, filename) => {
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
    csv[0]["Sensor_Type"]
  ]);

  csv.forEach((row) => {
    input.push([
      row["Timestamp"],
      row["Temperature_degC"],
      row["Humidity_%"],
      row[key]
    ]);
  });

  stringify(input, (err, output) => {
    // write the string to file
    fs.writeFileSync(`./outputs/${filename}.csv`, output);
  });
};

process.on('uncaughtException', (err) => {
  console.log(err);
  usage();
});