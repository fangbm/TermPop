import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const RELEASES_URL = "https://github.com/fangbm/TermPop/releases/latest";
const GITHUB_URL = "https://github.com/fangbm/TermPop";
const chromeStoreUrl = import.meta.env.VITE_CHROME_STORE_URL as string | undefined;
const edgeAddonsUrl = import.meta.env.VITE_EDGE_ADDONS_URL as string | undefined;

type Feature = {
  title: string;
  description: string;
  accent: "blue" | "violet" | "green" | "amber" | "cyan" | "rose";
};

const features: Feature[] = [
  {
    title: "Automatic highlights",
    description: "Scan the page and mark technical terms without changing your reading flow.",
    accent: "blue"
  },
  {
    title: "Hover explanations",
    description: "Move over a term to see a concise explanation card in context.",
    accent: "violet"
  },
  {
    title: "Selection mode",
    description: "Select any phrase and ask TermPop for an explanation from the context menu.",
    accent: "green"
  },
  {
    title: "PDF viewer",
    description: "Open PDFs in TermPop's own viewer for highlight and explanation support.",
    accent: "amber"
  },
  {
    title: "Local cache",
    description: "Reuse recent explanations and detected terms to reduce repeated calls.",
    accent: "cyan"
  },
  {
    title: "Rust + WASM core",
    description: "Run deterministic term detection locally with a compact WebAssembly core.",
    accent: "rose"
  }
];

function App(): React.ReactElement {
  return (
    <main>
      <Nav />
      <Hero />
      <ProductShowcase />
      <FeatureGrid />
      <DownloadSection />
      <Footer />
    </main>
  );
}

function Nav(): React.ReactElement {
  return (
    <header className="nav-shell">
      <nav className="nav" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="TermPop home">
          <span className="brand-mark">T</span>
          <span>TermPop</span>
        </a>
        <div className="nav-links">
          <a href="#features">Features</a>
          <a href="#download">Download</a>
          <a href={GITHUB_URL}>GitHub</a>
        </div>
      </nav>
    </header>
  );
}

function Hero(): React.ReactElement {
  return (
    <section className="hero" id="top">
      <p className="eyebrow">Chrome and Edge extension</p>
      <h1>Explain terms without leaving the page.</h1>
      <p className="hero-copy">
        TermPop highlights technical words, acronyms, framework names, and product terms as you read,
        then opens a focused explanation exactly where your attention already is.
      </p>
      <div className="hero-actions" aria-label="Download and source links">
        <a className="button button-primary" href="#download">
          Download extension
        </a>
        <a className="button button-secondary" href={GITHUB_URL}>
          View on GitHub
        </a>
      </div>
    </section>
  );
}

function ProductShowcase(): React.ReactElement {
  return (
    <section className="showcase" aria-label="TermPop product preview">
      <div className="browser-frame">
        <div className="browser-bar">
          <span />
          <span />
          <span />
          <div className="address">termpop.dev/docs/attention</div>
        </div>
        <div className="browser-page">
          <article className="article-card">
            <p className="article-kicker">Technical reading</p>
            <h2>Attention models made readable.</h2>
            <p>
              A <Highlighted>Transformer</Highlighted> uses <Highlighted>self-attention</Highlighted> to
              model relationships across tokens. TermPop can explain <Highlighted>WASM</Highlighted>,{" "}
              <Highlighted>LLM</Highlighted>, and <Highlighted>GPU</Highlighted> while you keep reading.
            </p>
          </article>
          <aside className="explain-card" aria-label="Example explanation card">
            <div className="card-topline">
              <strong>WASM</strong>
              <span>95%</span>
            </div>
            <p>WebAssembly, a portable binary format that lets Rust code run efficiently in the browser.</p>
            <div className="chips">
              <span>Rust</span>
              <span>Browser extension</span>
              <span>Runtime</span>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

function Highlighted({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="highlight">{children}</span>;
}

function FeatureGrid(): React.ReactElement {
  return (
    <section className="section" id="features">
      <div className="section-heading">
        <p className="eyebrow">Built for reading</p>
        <h2>Small interactions, useful context.</h2>
        <p>
          TermPop stays quiet until you need it, then brings definitions, context, and related tags into a
          compact card.
        </p>
      </div>
      <div className="feature-grid">
        {features.map((feature) => (
          <article className={`feature-card accent-${feature.accent}`} key={feature.title}>
            <div className="feature-icon" aria-hidden="true" />
            <h3>{feature.title}</h3>
            <p>{feature.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function DownloadSection(): React.ReactElement {
  const hasStoreLinks = Boolean(chromeStoreUrl || edgeAddonsUrl);

  return (
    <section className="download-section" id="download">
      <div className="download-panel">
        <p className="eyebrow">Get TermPop</p>
        <h2>Install the extension and start reading with context.</h2>
        <p>
          The current public build is distributed through GitHub Releases. Store links are ready to replace
          this button when Chrome Web Store or Edge Add-ons listings are available.
        </p>
        <div className="download-actions">
          {hasStoreLinks ? (
            <>
              {chromeStoreUrl ? (
                <a className="button button-primary" href={chromeStoreUrl}>
                  Chrome Web Store
                </a>
              ) : null}
              {edgeAddonsUrl ? (
                <a className="button button-secondary" href={edgeAddonsUrl}>
                  Edge Add-ons
                </a>
              ) : null}
            </>
          ) : (
            <a className="button button-primary" href={RELEASES_URL}>
              Download latest release
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function Footer(): React.ReactElement {
  return (
    <footer className="footer">
      <span>TermPop</span>
      <a href={GITHUB_URL}>GitHub</a>
      <a href={RELEASES_URL}>Releases</a>
      <a href={`${GITHUB_URL}#license`}>MIT License</a>
    </footer>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
