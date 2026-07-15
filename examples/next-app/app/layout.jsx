import './style.css';

export const metadata = {
  title: 'Meridian, revenue analytics that answer back',
  description: 'Demo app for the Visual Web Canvas live Next.js workflow.',
};

export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
