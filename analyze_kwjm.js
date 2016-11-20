// accepts one CSV file, with a header row, as an argument
// generates a CSV file per column, using timestamp, temperature,
// and humidity from the source file

let parse = require('csv-parse');
let stringify = require('csv-stringify');
let fs = require('fs');
let argv = require('minimist')(process.argv.slice(2));

let usage = () => {
  console.log(`
Usage: analyze_kwjm --i=filename.csv
`);

};

let input_filename = argv.i || "usb0.csv";

// check to see if the input file exists and if not exit with an error message and usage
let input = fs.readFileSync(input_filename);
parse(input, {columns: true}, (err, csv) => {
  let keys = Object.keys(csv[0]);

  // create an array for each column
  let results = {};
  keys.forEach((key) => {
    results[key] = [];
    if(key.indexOf("Slot") >= 0){
      createIndividualCsv(key, csv);
    }
  });

  // transpose the rows into columns
  // and coerce the results into numbers
  csv.forEach( (row) => {
    Object.keys(row).forEach((key) => {
      if(key != "Sensor_Type"){
        results[key].push(+row[key]);
      }
      else{
        results[key].push(row[key]);
      }
    });
  });


});

let createIndividualCsv = (key, csv) => {
  console.log(`Creating ./outputs/${key}.csv`);

  if (!fs.existsSync('./outputs')){
    fs.mkdirSync('./outputs');
  }

  let input = [];
  input.push([
    "Timestamp",
    "Sensor_Type",
    "Temperature_degC",
    "Humidity_%",
    key
  ]);

  csv.forEach((row) => {
    input.push([
      row["Timestamp"],
      row["Sensor_Type"],
      row["Temperature_degC"],
      row["Humidity_%"],
      row[key]
    ]);
  });

  stringify(input, (err, output) => {
    // write the string to file
    fs.writeFileSync(`./outputs/${key}.csv`, output);
  });
};

process.on('uncaughtException', (err) => {
  console.log(err);
  usage();
});