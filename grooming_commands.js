// looks up the grooming commands for a given sensor board and prints them to the screen
let parse = require('csv-parse');
let syncParse = require('csv-parse/lib/sync');
let stringify = require('csv-stringify');
let fs = require('fs');
let argv = require('minimist')(process.argv.slice(2));
let path = require('path');

let usage = () => {
  console.log(`
  
Usage: grooming_commands --batch=3 --serial=14 --json_folder=”/path/to/folder” --sensor_boards_db=”/path/to/file.json”
`);

};

let zero_pad = (n, digits) => {
  let str = `${n}`;
  while(str.length < digits){
    str = `0${str}`;
  }
  return str;
};

let batch = argv.batch || null;
let serial = argv.serial || null;
let json_folder = argv.json_folder || '.';
let sensor_boards_db = argv.sensor_boards_db || null;

if(batch === null || serial === null || sensor_boards_db === null){
  usage();
  process.exit(1);
}

// read sensor_boards_db into memory
let sensors_database = fs.readFileSync(sensor_boards_db).toString();
sensors_database = syncParse(sensors_database, {auto_parse: true, skip_empty_lines: true});
// console.log(JSON.stringify(sensors_database, null, 2));

const IDX_SENSOR_BOARD_BATCH = 0;
const IDX_SENSOR_BOARD_SERIAL = 1;
const IDX_CO_KWJ_BATCH = 3;
const IDX_CO_KWJ_SERIAL = 4;
const IDX_NO2_KWJ_BATCH = 5;
const IDX_NO2_KWJ_SERIAL = 6;

let targetIndex = -1;
let numFound = 0;
let record = null;

for(let ii = 0; ii < sensors_database.length; ii++){
  let r = sensors_database[ii];
  if(r[IDX_SENSOR_BOARD_BATCH] === batch && r[IDX_SENSOR_BOARD_SERIAL] === serial){
    targetIndex = ii;
    numFound++;
    record = r;
  }
}

if(numFound == 1){
  // look up the JSON records for the target Index
  let no2_record = null;
  numFound = 0;
  for(let ii = 1; ii < 50; ii++){
    try{
      let filename = path.join(json_folder,
        `NO2_Batch_${zero_pad(record[IDX_NO2_KWJ_BATCH], 5)}_Serial_${zero_pad(record[IDX_NO2_KWJ_SERIAL], 5)}_Slot_${zero_pad(ii,2)}_blv.json`);
      no2_record = require(filename);
      numFound++;
    }
    catch(err){
      // meh.
    }
  }

  if(numFound !== 1){
    console.log(`${numFound} NO2 Records Found. Should have been exactly 1`);
  }


  let co_record = null;
  numFound = 0;
  for(let ii = 1; ii < 50; ii++){
    try{
      let filename = path.join(json_folder,
        `CO_Batch_${zero_pad(record[IDX_CO_KWJ_BATCH], 5)}_Serial_${zero_pad(record[IDX_CO_KWJ_SERIAL], 5)}_Slot_${zero_pad(ii,2)}_blv.json`);
      // console.log(filename);
      co_record = require(filename);
      numFound++;
    }
    catch(err){
      // meh.
    }
  }

  if(numFound !== 1){
    console.log(`${numFound} CO Records Found. Should have been exactly 1`);
  }

  if(no2_record){
    no2_record.commands.forEach((command) => {
      console.log(command);
    });
  }

  if(co_record){
    co_record.commands.forEach((command) => {
      console.log(command);
    });
  }

}
else{
  if(numFound == 0) {
    console.log(`Couldn't find record for Sensor Board Batch #${batch} / Serial #${serial}`);
  }
  else if(numFound > 1){
    console.log(`Found ${numFound} records for Sensor Board Batch #${batch} / Serial #${serial}, but should only have found 1`);
  }
  usage();
}

process.on('uncaughtException', (err) => {
  console.log(err);
  usage();
});
