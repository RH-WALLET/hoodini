/**
 * scripts/v4-hooks.ts — census of Uniswap V4 launch venues, by hook contract.
 *
 * On V4 a launchpad is identified by the hook attached to its pools, not by a
 * factory address. Enumerating Initialize events on the PoolManager and
 * grouping by hook yields a ranked list of every V4-based launch venue on the
 * chain — including ones no name search would ever surface.
 *
 * READ-ONLY. No signer.
 *
 *   pnpm v4-hooks
 */

import { createPublicClient, http, defineChain, parseAbiItem } from 'viem';
const RPC='https://rpc.mainnet.chain.robinhood.com';
const B='https://robinhoodchain.blockscout.com/api/v2';
const chain=defineChain({id:4663,name:'RH',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[RPC]}}});
const c=createPublicClient({chain,transport:http(RPC)});
const PM='0x8366a39CC670B4001A1121B8F6A443A643e40951' as const;
const ev=parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const head=await c.getBlockNumber();
const span=200_000n; // ~5.5h at 0.1s blocks
console.log(`V4 PoolManager ${PM}: Initialize events over last ${span} blocks (head ${head})\n`);
let logs:any[]=[];
try{ logs=await c.getLogs({address:PM,event:ev,fromBlock:head-span,toBlock:head}); }
catch(e){ console.log('getLogs failed:',(e as Error).message.split('\n')[0]); }
console.log(`found ${logs.length} pool initializations`);
const names=new Map<string,string>();
async function nm(a:string){ if(names.has(a))return names.get(a)!;
  try{ const j=await (await fetch(`${B}/addresses/${a}`)).json() as any; const n=j.token?.symbol??j.name??'?'; names.set(a,n); return n; }catch{ return '?' } }
for(const l of logs.slice(-25)){
  const a:any=l.args;
  const c0=a.currency0===('0x0000000000000000000000000000000000000000')?'ETH(native)':await nm(a.currency0);
  const c1=await nm(a.currency1);
  console.log(`  blk ${l.blockNumber}  ${c0} / ${c1}  fee=${a.fee} spacing=${a.tickSpacing} hooks=${a.hooks}`);
}
const hooks=new Map<string,number>();
for(const l of logs){ const h=(l.args as any).hooks as string; hooks.set(h,(hooks.get(h)??0)+1); }
console.log('\nhook contracts (a launchpad on V4 would show up here):');
for(const [h,n] of [...hooks.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)){
  console.log(`  ${n.toString().padStart(4)}  ${h}  ${h==='0x0000000000000000000000000000000000000000'?'(no hook)':await nm(h)}`);
}
