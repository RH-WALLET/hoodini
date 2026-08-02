/**
 * scripts/factories.ts — sweep every Pons-interface launch factory on the chain.
 *
 * The Pons/NOXA factory interface has been cloned repeatedly on RH Chain, so
 * tracking clones by name does not work. This probes every factory-shaped
 * contract for the interface itself (dexConfigCount / launchFee / getDexConfig)
 * and prints each one's declared DEX config — router, fee tier, enabled state.
 *
 * The point: any factory answering this interface is tradeable by the SAME
 * adapter, whatever it calls itself. It also surfaces the protocol's own
 * declared swapRouter, which is stronger evidence than observed traffic.
 *
 * READ-ONLY. No signer.
 *
 *   pnpm factories
 */

import { createPublicClient, http, defineChain, getAddress, type Abi } from 'viem';
const RPC='https://rpc.mainnet.chain.robinhood.com';
const B='https://robinhoodchain.blockscout.com/api/v2';
const chain=defineChain({id:4663,name:'RH',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[RPC]}}});
const c=createPublicClient({chain,transport:http(RPC)});
const abi=((await (await fetch(`${B}/smart-contracts/0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb`)).json()) as {abi:Abi}).abi;

const cands=new Map<string,string>();
for(const q of ['LaunchFactory','PonsLaunchFactory','Factory','Launcher','Pons']){
  const r=await (await fetch(`${B}/search?q=${q}`)).json() as {items?:{type:string;address?:string;address_hash?:string;name?:string}[]};
  for(const i of r.items??[]){
    if(i.type!=='contract') continue;
    const a=i.address??i.address_hash; if(!a) continue;
    if(/token|pool|pair/i.test(i.name??'')) continue;
    cands.set(getAddress(a), i.name??'?');
  }
}
console.log(`probing ${cands.size} factory-shaped contracts for launch/dex configs\n`);
for(const [addr,name] of cands){
  try{
    const dc=await c.readContract({address:addr as `0x${string}`,abi,functionName:'dexConfigCount'}) as bigint;
    const fee=await c.readContract({address:addr as `0x${string}`,abi,functionName:'launchFee'}) as bigint;
    const en=await c.readContract({address:addr as `0x${string}`,abi,functionName:'launchEnabled'}) as boolean;
    const dexes:string[]=[];
    for(let i=0n;i<dc;i++){
      const d=await c.readContract({address:addr as `0x${string}`,abi,functionName:'getDexConfig',args:[i]}) as any;
      dexes.push(`${d.name} (router ${d.swapRouter}, fee ${d.poolFee}, enabled ${d.enabled})`);
    }
    const ctr=await (await fetch(`${B}/addresses/${addr}/counters`)).json() as {transactions_count?:string};
    console.log(`${addr}  ${name}`);
    console.log(`   fee=${Number(fee)/1e18} ETH  enabled=${en}  txs=${ctr.transactions_count??'?'}`);
    dexes.forEach(d=>console.log(`   dex: ${d}`));
  }catch{ /* not a launch factory */ }
}
