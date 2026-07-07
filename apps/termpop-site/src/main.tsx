import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const RELEASES_URL = "https://github.com/fangbm/TermPop/releases/latest";
const GITHUB_URL = "https://github.com/fangbm/TermPop";
const chromeStoreUrl = import.meta.env.VITE_CHROME_STORE_URL as string | undefined;
const edgeAddonsUrl = import.meta.env.VITE_EDGE_ADDONS_URL as string | undefined;
const LANGUAGE_STORAGE_KEY = "termpop-site-language";

type Language = "en" | "zh";
type Accent = "blue" | "violet" | "green" | "amber" | "cyan" | "rose";

type Feature = {
  title: string;
  description: string;
  accent: Accent;
};

type Copy = {
  nav: {
    features: string;
    download: string;
    github: string;
    languageLabel: string;
    homeLabel: string;
  };
  hero: {
    eyebrow: string;
    title: string;
    copy: string;
    download: string;
    github: string;
    actionsLabel: string;
  };
  showcase: {
    label: string;
    address: string;
    kicker: string;
    title: string;
    textStart: string;
    textMiddle: string;
    textEnd: string;
    explanation: string;
    chips: string[];
  };
  features: {
    eyebrow: string;
    title: string;
    copy: string;
    items: Feature[];
  };
  download: {
    eyebrow: string;
    title: string;
    copy: string;
    latest: string;
    chromeStore: string;
    edgeAddons: string;
  };
  footer: {
    releases: string;
    license: string;
  };
};

const copy: Record<Language, Copy> = {
  en: {
    nav: {
      features: "Features",
      download: "Download",
      github: "GitHub",
      languageLabel: "Choose language",
      homeLabel: "TermPop home"
    },
    hero: {
      eyebrow: "Chrome and Edge extension",
      title: "Explain terms without leaving the page.",
      copy:
        "TermPop highlights technical words, acronyms, framework names, and product terms as you read, then opens a focused explanation exactly where your attention already is.",
      download: "Download extension",
      github: "View on GitHub",
      actionsLabel: "Download and source links"
    },
    showcase: {
      label: "TermPop product preview",
      address: "termpop.dev/docs/attention",
      kicker: "Technical reading",
      title: "Attention models made readable.",
      textStart: "A",
      textMiddle: "uses",
      textEnd: "to model relationships across tokens. TermPop can explain",
      explanation: "WebAssembly, a portable binary format that lets Rust code run efficiently in the browser.",
      chips: ["Rust", "Browser extension", "Runtime"]
    },
    features: {
      eyebrow: "Built for reading",
      title: "Small interactions, useful context.",
      copy: "TermPop stays quiet until you need it, then brings definitions, context, and related tags into a compact card.",
      items: [
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
      ]
    },
    download: {
      eyebrow: "Get TermPop",
      title: "Install the extension and start reading with context.",
      copy:
        "The current public build is distributed through GitHub Releases. Store links are ready to replace this button when Chrome Web Store or Edge Add-ons listings are available.",
      latest: "Download latest release",
      chromeStore: "Chrome Web Store",
      edgeAddons: "Edge Add-ons"
    },
    footer: {
      releases: "Releases",
      license: "MIT License"
    }
  },
  zh: {
    nav: {
      features: "功能",
      download: "下载",
      github: "GitHub",
      languageLabel: "选择语言",
      homeLabel: "TermPop 首页"
    },
    hero: {
      eyebrow: "适用于Chrome和Edge的浏览器插件",
      title: "不离开页面，\n也能看懂术语。",
      copy:
        "TermPop 会在阅读时标出技术词、缩写、框架名和产品名，并在你停留的位置打开简洁的上下文解释卡。",
      download: "下载插件",
      github: "查看 GitHub",
      actionsLabel: "下载和源码链接"
    },
    showcase: {
      label: "TermPop 产品预览",
      address: "termpop.dev/docs/attention",
      kicker: "技术阅读",
      title: "让Tramsformer更容易读懂。",
      textStart: "一个",
      textMiddle: "会使用",
      textEnd: "来建模 token 之间的关系。TermPop 可以在阅读中解释",
      explanation: "WebAssembly 是一种可移植的二进制格式，可以让 Rust 代码在浏览器中高效运行。",
      chips: ["Rust", "浏览器插件", "运行时"]
    },
    features: {
      eyebrow: "为阅读而生",
      title: "轻量交互，\n刚好的上下文。",
      copy: "TermPop 平时保持安静；当你需要时，它会把定义、上下文和相关标签放进一张紧凑的解释卡。",
      items: [
        {
          title: "自动高亮",
          description: "扫描页面并标记技术术语，不打断原本的阅读节奏。",
          accent: "blue"
        },
        {
          title: "悬停解释",
          description: "鼠标停在术语上，就能看到结合上下文的简短解释。",
          accent: "violet"
        },
        {
          title: "划词模式",
          description: "选中任意短语，通过右键菜单让 TermPop 解释。",
          accent: "green"
        },
        {
          title: "PDF 阅读器",
          description: "使用 TermPop 自带的 PDF viewer，获得高亮和解释支持。",
          accent: "amber"
        },
        {
          title: "本地缓存",
          description: "复用近期词条和解释，减少重复请求。",
          accent: "cyan"
        },
        {
          title: "Rust + WASM 内核",
          description: "用紧凑的 WebAssembly 内核在本地执行稳定的术语检测。",
          accent: "rose"
        }
      ]
    },
    download: {
      eyebrow: "获取 TermPop",
      title: "安装插件，\n从带上下文的阅读开始。",
      copy:
        "当前公开版本通过 GitHub Releases 分发。",
      latest: "下载最新版",
      chromeStore: "Chrome 应用商店",
      edgeAddons: "Edge 加载项"
    },
    footer: {
      releases: "发布版本",
      license: "MIT 许可证"
    }
  }
};

function initialLanguage(): Language {
  const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (saved === "en" || saved === "zh") {
    return saved;
  }

  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function App(): React.ReactElement {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const t = copy[language];

  useEffect(() => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title =
      language === "zh" ? "TermPop - 不离开页面，也能看懂术语" : "TermPop - Explain terms without leaving the page";
  }, [language]);

  const storeLinks = useMemo(
    () => ({
      chromeStoreUrl,
      edgeAddonsUrl
    }),
    []
  );

  return (
    <main>
      <Nav language={language} setLanguage={setLanguage} t={t} />
      <Hero t={t} />
      <ProductShowcase t={t} />
      <FeatureGrid t={t} />
      <DownloadSection storeLinks={storeLinks} t={t} />
      <Footer t={t} />
    </main>
  );
}

function Nav({
  language,
  setLanguage,
  t
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Copy;
}): React.ReactElement {
  return (
    <header className="nav-shell">
      <nav className="nav" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label={t.nav.homeLabel}>
          <img className="brand-mark" src="/termpop-icon.png" alt="" aria-hidden="true" />
          <span>TermPop</span>
        </a>
        <div className="nav-right">
          <div className="nav-links">
            <a href="#features">{t.nav.features}</a>
            <a href="#download">{t.nav.download}</a>
            <a href={GITHUB_URL}>{t.nav.github}</a>
          </div>
          <div className="language-switch" aria-label={t.nav.languageLabel}>
            <button
              type="button"
              className={language === "en" ? "active" : ""}
              aria-pressed={language === "en"}
              onClick={() => setLanguage("en")}
            >
              EN
            </button>
            <button
              type="button"
              className={language === "zh" ? "active" : ""}
              aria-pressed={language === "zh"}
              onClick={() => setLanguage("zh")}
            >
              中文
            </button>
          </div>
        </div>
      </nav>
    </header>
  );
}

function Hero({ t }: { t: Copy }): React.ReactElement {
  return (
    <section className="hero" id="top">
      <p className="eyebrow">{t.hero.eyebrow}</p>
      <h1 style={{ whiteSpace: 'pre-line' }}>{t.hero.title}</h1>
      <p className="hero-copy">{t.hero.copy}</p>
      <div className="hero-actions" aria-label={t.hero.actionsLabel}>
        <a className="button button-primary" href="#download">
          {t.hero.download}
        </a>
        <a className="button button-secondary" href={GITHUB_URL}>
          {t.hero.github}
        </a>
      </div>
    </section>
  );
}

function ProductShowcase({ t }: { t: Copy }): React.ReactElement {
  return (
    <section className="showcase" aria-label={t.showcase.label}>
      <div className="browser-frame">
        <div className="browser-bar">
          <span />
          <span />
          <span />
          <div className="address">{t.showcase.address}</div>
        </div>
        <div className="browser-page">
          <article className="article-card">
            <p className="article-kicker">{t.showcase.kicker}</p>
            <h2>{t.showcase.title}</h2>
            <p>
              {t.showcase.textStart} <Highlighted>Transformer</Highlighted> {t.showcase.textMiddle}{" "}
              <Highlighted>self-attention</Highlighted> {t.showcase.textEnd} <Highlighted>WASM</Highlighted>,{" "}
              <Highlighted>LLM</Highlighted>, <Highlighted>GPU</Highlighted>.
            </p>
          </article>
          <aside className="explain-card" aria-label="Example explanation card">
            <div className="card-topline">
              <strong>WASM</strong>
              <span>95%</span>
            </div>
            <p>{t.showcase.explanation}</p>
            <div className="chips">
              {t.showcase.chips.map((chip) => (
                <span key={chip}>{chip}</span>
              ))}
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

function FeatureGrid({ t }: { t: Copy }): React.ReactElement {
  return (
    <section className="section" id="features">
      <div className="section-heading">
        <p className="eyebrow">{t.features.eyebrow}</p>
        <h2 style={{ whiteSpace: 'pre-line' }}>{t.hero.title}</h2>
        <p>{t.features.copy}</p>
      </div>
      <div className="feature-grid">
        {t.features.items.map((feature) => (
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

function DownloadSection({
  storeLinks,
  t
}: {
  storeLinks: { chromeStoreUrl?: string; edgeAddonsUrl?: string };
  t: Copy;
}): React.ReactElement {
  const hasStoreLinks = Boolean(storeLinks.chromeStoreUrl || storeLinks.edgeAddonsUrl);

  return (
    <section className="download-section" id="download">
      <div className="download-panel">
        <p className="eyebrow">{t.download.eyebrow}</p>
        <h2 style={{ whiteSpace: 'pre-line' }}>{t.hero.title}</h2>
        <p>{t.download.copy}</p>
        <div className="download-actions">
          {hasStoreLinks ? (
            <>
              {storeLinks.chromeStoreUrl ? (
                <a className="button button-primary" href={storeLinks.chromeStoreUrl}>
                  {t.download.chromeStore}
                </a>
              ) : null}
              {storeLinks.edgeAddonsUrl ? (
                <a className="button button-secondary" href={storeLinks.edgeAddonsUrl}>
                  {t.download.edgeAddons}
                </a>
              ) : null}
            </>
          ) : (
            <a className="button button-primary" href={RELEASES_URL}>
              {t.download.latest}
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function Footer({ t }: { t: Copy }): React.ReactElement {
  return (
    <footer className="footer">
      <span>TermPop</span>
      <a href={GITHUB_URL}>GitHub</a>
      <a href={RELEASES_URL}>{t.footer.releases}</a>
      <a href={`${GITHUB_URL}#license`}>{t.footer.license}</a>
    </footer>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
