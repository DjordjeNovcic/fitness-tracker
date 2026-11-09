const db=new Map();
const key=r=>r.path;
const snap=r=>({exists:()=>db.has(key(r)),data:()=>db.get(key(r)),id:r.id});
export function getFirestore(){return {};}
export function doc(_d,...p){return {path:p.join("/"),id:p[p.length-1]};}
export function collection(_d,...p){return {path:p.join("/")};}
export function query(c){return c;} export function limit(){return null;}
export async function getDoc(r){return snap(r);}
export async function getDocs(){return {docs:[],forEach(){},empty:true,size:0};}
export async function setDoc(r,v){db.set(key(r),v);}
export async function deleteDoc(r){db.delete(key(r));}
export function serverTimestamp(){return Date.now();}
export async function runTransaction(_d,fn){return fn({get:async r=>snap(r),set:(r,v)=>db.set(key(r),v),update:(r,v)=>db.set(key(r),{...db.get(key(r)),...v}),delete:r=>db.delete(key(r))});}
