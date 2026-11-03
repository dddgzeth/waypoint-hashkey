import "dotenv/config";
import { createPublicClient, http, formatEther } from "viem";
import { polygon } from "viem/chains";
const rpc = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const client = createPublicClient({ chain: polygon, transport: http(rpc) });
const bal = await client.getBalance({ address: "0x3F4436128B0DE87785Fe67A456D6f7b0a9fF096C" });
console.log("POL balance:", formatEther(bal));
