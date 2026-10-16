import {readFile} from 'node:fs/promises';
import pg from 'pg';
const url=process.env.DATABASE_URL;
if(!url)throw new Error('DATABASE_URL missing');
const pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:10000});
try{
  await pool.query(await readFile(new URL('./db/schema.sql',import.meta.url),'utf8'));
  console.log('Schema ready');
}finally{await pool.end();}
