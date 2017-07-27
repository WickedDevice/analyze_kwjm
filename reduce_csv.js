let fs = require('fs');
let syncParse = require('csv-parse/lib/sync');
let argv = require('minimist')(process.argv.slice(2));
let stringify = require('csv-stringify');

let dir = argv.dir || "outputs";
let strip_first = argv.strip_first || 10;
let strip_last = argv.strip_last || 10;
let keep_cols = argv.keep_cols || "0,8";
keep_cols = keep_cols.split(",").map(v => +v);

if(argv.help){
  console.log(`Usage: node reduce_csv --dir=outputs_folder --strip_first=100 --strip_last=100 --keep_cols=0,3`);
  process.exit(0);
}

let files = fs.readdirSync(dir);
let ii = 0;
files.forEach((fname) => {
  let filedata = fs.readFileSync(`${dir}/${fname}`);
  let csvdata = syncParse(filedata, {auto_parse: true, skip_empty_lines: true});
  let header = csvdata[0].filter((v,idx) => {
    return (keep_cols.indexOf(idx) >= 0);
  });

  csvdata = csvdata.slice(strip_first + 1, -strip_last);
  csvdata = csvdata.map((r) => {
    return r.filter((v,idx) => {
      return (keep_cols.indexOf(idx) >= 0);
    });
  });
  csvdata.unshift(header);

  stringify(csvdata, (err, output) => {
    if(err){
      console.log("Error: ", err);
    }
    console.log("Output:", output);
    fs.writeFileSync(`${dir}/${fname}`, output);
  });
  ii++;
});
