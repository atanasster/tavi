// A small made-up website for the browser guides' walks, served on 127.0.0.1
// at a free port: Harbour Lane Books, a bookshop page whose shelves, filter and
// sort are buttons (`/`), and Island Ferry's seat plan, drawn on a canvas so
// only acting by sight can pick a seat (`/seats`). Run with `node`; it prints
// its address on the first line, then `chosen <seat>` each time a seat is
// picked. Nothing on it is real, and it keeps nothing.
import { createServer } from "node:http";

const BOOKS = [
  { title: "The Lighthouse Keeper's Daughter", author: "Mara Quill", price: 12.5, shelf: "fiction", stock: true },
  { title: "Salt and Lanterns", author: "Ivo Brandt", price: 9.99, shelf: "fiction", stock: true },
  { title: "A Winter on the Pier", author: "Ruth Okafor", price: 14, shelf: "fiction", stock: false },
  { title: "The Tide Clock", author: "Jonah Wilde", price: 7.25, shelf: "fiction", stock: true },
  { title: "Walking the Coast Path", author: "Ana Ferreira", price: 18, shelf: "travel", stock: true },
  { title: "Islands by Ferry", author: "Tom Hale", price: 16.5, shelf: "travel", stock: false },
  { title: "Puffin Goes to Sea", author: "Lily Marsh", price: 6, shelf: "children", stock: true },
];

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:44rem;color:#1d2a33}header{border-bottom:2px solid #2a6f8f;margin-bottom:1rem}
nav button,.tools button{margin-right:.5rem;padding:.4rem .8rem}button[aria-pressed=true]{background:#2a6f8f;color:#fff}
ul{list-style:none;padding:0}li{border:1px solid #cfdbe2;border-radius:6px;padding:.6rem;margin:.4rem 0}.price{font-weight:600}</style></head><body>${body}</body></html>`;

const books = page(
  "Harbour Lane Books",
  `<header><h1>Harbour Lane Books</h1><p>A small bookshop by the harbour.</p></header>
<nav aria-label="Shelves"><button type="button" data-shelf="fiction">Fiction</button><button type="button" data-shelf="travel">Travel</button><button type="button" data-shelf="children">Children's</button></nav>
<div class="tools"><label><input type="checkbox" id="stock"> In stock only</label> <button type="button" id="sort">Sort by price</button></div>
<h2 id="heading">Choose a shelf</h2><ul id="list"></ul><p role="status" id="count"></p>
<script>const BOOKS=${JSON.stringify(BOOKS)};let shelf=null,sorted=false;
function draw(){const list=document.getElementById("list");list.innerHTML="";if(!shelf)return;let rows=BOOKS.filter(b=>b.shelf===shelf);
if(document.getElementById("stock").checked)rows=rows.filter(b=>b.stock);if(sorted)rows=[...rows].sort((a,b)=>a.price-b.price);
for(const b of rows){const li=document.createElement("li");li.innerHTML="<strong>"+b.title+"</strong> by "+b.author+" · <span class=price>£"+b.price.toFixed(2)+"</span> · "+(b.stock?"In stock":"Out of stock");list.appendChild(li);}
document.getElementById("heading").textContent=shelf[0].toUpperCase()+shelf.slice(1)+" shelf";document.getElementById("count").textContent=rows.length+" books";}
for(const b of document.querySelectorAll("nav button"))b.onclick=()=>{shelf=b.dataset.shelf;for(const o of document.querySelectorAll("nav button"))o.setAttribute("aria-pressed",o===b);draw();};
document.getElementById("stock").onchange=draw;document.getElementById("sort").onclick=()=>{sorted=true;draw();};</script>`,
);

const seats = page(
  "Island Ferry — choose a seat",
  `<header><h1>Island Ferry</h1><p>Choose a seat on the seat plan.</p></header>
<canvas id="plan" width="420" height="260" style="border:1px solid #cfdbe2"></canvas><p role="status" id="chosen">No seat chosen yet.</p>
<script>const c=document.getElementById("plan"),x=c.getContext("2d");const rows=[1,2,3,4],cols=["A","B","C","D"];let pick=null;
const at=(i,j)=>[60+j*80+(j>1?20:0),40+i*52];
function draw(){x.clearRect(0,0,420,260);x.font="16px system-ui";x.fillStyle="#1d2a33";x.fillText("Bow",190,22);
rows.forEach((r,i)=>cols.forEach((l,j)=>{const[px,py]=at(i,j);x.fillStyle=pick===r+l?"#2a6f8f":"#e3edf2";x.fillRect(px,py,56,40);
x.fillStyle=pick===r+l?"#fff":"#1d2a33";x.fillText(r+l,px+18,py+26);}));}
c.onclick=e=>{const b=c.getBoundingClientRect(),mx=e.clientX-b.left,my=e.clientY-b.top;rows.forEach((r,i)=>cols.forEach((l,j)=>{const[px,py]=at(i,j);
if(mx>=px&&mx<=px+56&&my>=py&&my<=py+40){pick=r+l;document.getElementById("chosen").textContent="Seat "+pick+" chosen.";fetch("/chosen?seat="+pick);}}));draw();};draw();</script>`,
);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/chosen") {
    console.log(`chosen ${url.searchParams.get("seat")}`);
    response.writeHead(204);
    response.end();
    return;
  }
  const body = url.pathname === "/" ? books : url.pathname === "/seats" ? seats : undefined;
  response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
  response.end(body ?? "Not found");
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
