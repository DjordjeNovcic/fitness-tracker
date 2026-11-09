const mode=(()=>{try{return localStorage.getItem('stub-mode')||'demo'}catch(e){return 'demo'}})();
const user=mode==='new'?{uid:"new-uid",email:"ana@example.com",displayName:""}:{uid:"demo-uid",email:"demo@fittracker.app",displayName:"Demo"};
let cur=mode==='out'?null:user;let cbs=[];
export function getAuth(){return {get currentUser(){return cur}};}
export function onAuthStateChanged(a,cb){cbs.push(cb);setTimeout(()=>cb(cur),50);return ()=>{};}
export async function signInWithEmailAndPassword(){cur=user;cbs.forEach(c=>c(cur));return {user};}
export async function createUserWithEmailAndPassword(){cur=user;cbs.forEach(c=>c(cur));return {user};}
export async function signOut(){cur=null;cbs.forEach(c=>c(null));}
export async function deleteUser(){}
export async function reauthenticateWithCredential(){}
export async function sendPasswordResetEmail(){}
export const EmailAuthProvider={credential:()=>({})};
