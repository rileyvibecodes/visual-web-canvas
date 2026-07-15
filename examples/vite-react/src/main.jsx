import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const features = [
  {
    title: 'One page a day',
    text: 'Fieldnote opens to a single dated page. No folders to manage, no blank-canvas dread, just today.',
  },
  {
    title: 'Ink that remembers',
    text: 'Every note is searchable the moment you stop typing. Yesterday is one keystroke away.',
  },
  {
    title: 'Yours, locally',
    text: 'Notes live in plain files on your machine. Export everything, any time, in one click.',
  },
];

function Nav() {
  return (
    <nav>
      <span className="brand">Fieldnote</span>
      <div className="links">
        <a href="#features">Features</a>
        <a href="#pricing">Pricing</a>
        <a className="cta" href="#start">Start writing</a>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <header className="hero">
      <p className="eyebrow">A notebook, not a workspace</p>
      <h1>Write it down before it disappears.</h1>
      <p className="lede">
        Fieldnote is a daily page for people who think by writing. Open it,
        put the thought down, get back to your day.
      </p>
      <div className="actions">
        <a className="cta" href="#start">Start your first page</a>
        <span className="note">Free for 30 days · No card required</span>
      </div>
    </header>
  );
}

function FeatureCard({ title, text }) {
  return (
    <article className="card">
      <h2>{title}</h2>
      <p>{text}</p>
    </article>
  );
}

function Quote() {
  return (
    <section className="quote">
      <blockquote>
        "I stopped organizing my notes and started actually writing them.
        Fieldnote got out of the way, which is the whole point."
      </blockquote>
      <cite>Jonah Reyes, essayist</cite>
    </section>
  );
}

function App() {
  return (
    <main>
      <Nav />
      <Hero />
      <section className="grid" id="features">
        {features.map((feature) => (
          <FeatureCard key={feature.title} {...feature} />
        ))}
      </section>
      <Quote />
      <footer>© 2026 Fieldnote. A fictional product for this demo.</footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
