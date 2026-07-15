import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function OfferCard({ title, text }) {
  return <article className="card"><span className="label">Included</span><h2>{title}</h2><p>{text}</p><button>See the system</button></article>;
}

function App() {
  return <main><header><p className="eyebrow">Visual Web Canvas demo</p><h1>Click this React component.</h1><p>Select it in Inspect mode, open its source, then switch to Design mode and edit it visually.</p></header><section><OfferCard title="Source-linked design" text="React context, Tailwind-ready transforms, and your existing Claude conversation." /></section></main>;
}

createRoot(document.getElementById('root')).render(<App />);
