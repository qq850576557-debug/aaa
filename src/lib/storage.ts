import { openDB } from 'idb';
import { emptyData, parseBackup, type Data } from './model';
const db = () => openDB('chunmo-workspace',1,{upgrade(db){db.createObjectStore('workspace');}});
export async function loadData():Promise<Data>{const conn=await db();try{const raw=await conn.get('workspace','data');return raw===undefined?emptyData():parseBackup(raw);}finally{conn.close();}}
export async function saveData(data:Data){const valid=parseBackup(data);const conn=await db();try{await conn.put('workspace',valid,'data');}finally{conn.close();}}
