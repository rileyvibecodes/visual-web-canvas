const metrics = [
  { value: '$4.2M', label: 'pipeline tracked', trend: '+18% this quarter' },
  { value: '312', label: 'accounts watched', trend: '41 flagged this week' },
  { value: '9 min', label: 'to first insight', trend: 'down from 3 days' },
];

const capabilities = [
  {
    name: 'Ask in plain language',
    detail: 'Type "which deals stalled after the demo" and get the list, the reasons, and the owner for each one.',
  },
  {
    name: 'Alerts that explain themselves',
    detail: 'Every alert arrives with the metric, the change, and the three accounts driving it. No dashboard archaeology.',
  },
  {
    name: 'Numbers your CFO trusts',
    detail: 'One definition of revenue across every report, reconciled nightly against your billing system.',
  },
];

function Metric({ value, label, trend }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
      <em>{trend}</em>
    </div>
  );
}

function Capability({ name, detail }) {
  return (
    <article className="capability">
      <h2>{name}</h2>
      <p>{detail}</p>
    </article>
  );
}

export default function Page() {
  return (
    <main>
      <nav>
        <span className="brand">Meridian</span>
        <div className="links">
          <a href="#capabilities">Product</a>
          <a href="#metrics">Customers</a>
          <a className="cta" href="#start">Get a live demo</a>
        </div>
      </nav>

      <header className="hero">
        <p className="eyebrow">Revenue analytics</p>
        <h1>Know why the number moved.</h1>
        <p className="lede">
          Meridian watches every deal, account, and invoice, then tells you
          what changed and what to do about it, in plain language.
        </p>
        <a className="cta" href="#start">Get a live demo</a>
      </header>

      <section className="metrics" id="metrics">
        {metrics.map((metric) => (
          <Metric key={metric.label} {...metric} />
        ))}
      </section>

      <section className="capabilities" id="capabilities">
        {capabilities.map((capability) => (
          <Capability key={capability.name} {...capability} />
        ))}
      </section>

      <footer>© 2026 Meridian Analytics. A fictional product for this demo.</footer>
    </main>
  );
}
