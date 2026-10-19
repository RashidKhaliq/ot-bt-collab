import 'dotenv/config';
import {migrateSchema} from '../src/db.js';
try {await migrateSchema(); console.log('StockBridge schema migration complete.');process.exit(0)}
catch(err){console.error('Migration failed:',err);process.exit(1)}
