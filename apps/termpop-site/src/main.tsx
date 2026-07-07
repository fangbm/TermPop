import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

type ShowcaseTermKey = "transformer" | "selfAttention" | "wasm" | "llm" | "gpu";

type ShowcaseTerm = {
  term: string;
  termType: "Tech" | "Acronym";
  category: string;
  definition: string;
  relatedTerms: string[];
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

const HOVER_SHOW_DELAY_MS = 420;
const HIDE_DELAY_MS = 220;

const showcaseTerms: Record<Language, Record<ShowcaseTermKey, ShowcaseTerm>> = {
  en: {
    transformer: {
      term: "Transformer",
      termType: "Tech",
      category: "Neural network architecture",
      definition: "A model architecture built around attention, widely used by modern language models.",
      relatedTerms: ["attention", "LLM", "architecture"]
    },
    selfAttention: {
      term: "self-attention",
      termType: "Tech",
      category: "Context modeling method",
      definition: "A Transformer mechanism that lets each token attend to relevant positions in its context.",
      relatedTerms: ["Transformer", "token", "attention"]
    },
    wasm: {
      term: "WASM",
      termType: "Tech",
      category: "WebAssembly runtime",
      definition: "WebAssembly is a portable binary format that lets Rust code run efficiently in the browser.",
      relatedTerms: ["Rust", "Browser extension", "Runtime"]
    },
    llm: {
      term: "LLM",
      termType: "Acronym",
      category: "Large language model",
      definition: "A language model trained at large scale to understand, summarize, and generate text in context.",
      relatedTerms: ["AI", "context", "generation"]
    },
    gpu: {
      term: "GPU",
      termType: "Acronym",
      category: "Parallel processor",
      definition: "A processor designed for parallel computation, commonly used for graphics and machine learning workloads.",
      relatedTerms: ["parallel", "compute", "training"]
    }
  },
  zh: {
    transformer: {
      term: "Transformer",
      termType: "Tech",
      category: "神经网络架构",
      definition: "一种以注意力机制为核心的模型架构，广泛用于现代语言模型。",
      relatedTerms: ["attention", "LLM", "架构"]
    },
    selfAttention: {
      term: "self-attention",
      termType: "Tech",
      category: "上下文建模方法",
      definition: "Transformer 中的机制，让每个 token 根据上下文关注相关位置。",
      relatedTerms: ["Transformer", "token", "attention"]
    },
    wasm: {
      term: "WASM",
      termType: "Tech",
      category: "WebAssembly 运行格式",
      definition: "WebAssembly 是一种可移植的二进制格式，可以让 Rust 代码在浏览器中高效运行。",
      relatedTerms: ["Rust", "浏览器插件", "运行时"]
    },
    llm: {
      term: "LLM",
      termType: "Acronym",
      category: "大语言模型",
      definition: "在大规模文本上训练、能够结合上下文理解、总结和生成语言的模型。",
      relatedTerms: ["AI", "上下文", "生成"]
    },
    gpu: {
      term: "GPU",
      termType: "Acronym",
      category: "并行处理器",
      definition: "适合大量并行计算的处理器，常用于图形渲染和机器学习任务。",
      relatedTerms: ["并行", "计算", "训练"]
    }
  }
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
      title: "  不离开页面，\n  也能看懂术语。",
      copy:
        "TermPop 会在阅读时标出技术词、缩写、框架名和产品名，并在你停留的位置打开简洁的上下文解释卡。",
      download: "下载插件",
      github: "查看 GitHub",
      actionsLabel: "下载和源码链接"
    },
    showcase: {
      label: "TermPop 产品预览",
      address: "termpop.com/docs/attention",
      kicker: "技术阅读",
      title: "让Tramsformer\n更容易读懂。",
      textStart: "一个",
      textMiddle: "会使用",
      textEnd: "来建模 token 之间的关系。TermPop 可以在阅读中解释",
      explanation: "WebAssembly 是一种可移植的二进制格式，可以让 Rust 代码在浏览器中高效运行。",
      chips: ["Rust", "浏览器插件", "运行时"]
    },
    features: {
      eyebrow: "为阅读而生",
      title: "  轻量交互，\n  刚好的上下文。",
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
      title: "  安装插件，\n  从带上下文的阅读开始。",
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
      <ProductShowcase language={language} t={t} />
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
      <h1 style={{ whiteSpace: "pre-wrap" }}>{t.hero.title}</h1>
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

type Point = {
  x: number;
  y: number;
};

type ShowcaseOverlayState = {
  termKey: ShowcaseTermKey;
  locked: boolean;
  measuring: boolean;
  visible: boolean;
  left: number;
  top: number;
};

function ProductShowcase({ language, t }: { language: Language; t: Copy }): React.ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const currentAnchorRef = useRef<HTMLButtonElement | null>(null);
  const anchorPointRef = useRef<Point | undefined>(undefined);
  const initialPlacementRef = useRef<"above" | "below" | undefined>(undefined);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const repositionFrameRef = useRef<number | undefined>(undefined);
  const pointerOverCardRef = useRef(false);
  const pointerFocusRef = useRef(false);
  const lockedRef = useRef(false);
  const activeTermKeyRef = useRef<ShowcaseTermKey | null>(null);
  const [overlay, setOverlay] = useState<ShowcaseOverlayState | null>(null);
  const terms = showcaseTerms[language];
  const activeTerm = overlay ? terms[overlay.termKey] : null;

  const cancelHoverExplanation = () => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  };

  const cancelHide = () => {
    if (hideTimerRef.current !== undefined) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
  };

  const hideExplanation = () => {
    lockedRef.current = false;
    activeTermKeyRef.current = null;
    currentAnchorRef.current = null;
    anchorPointRef.current = undefined;
    initialPlacementRef.current = undefined;
    pointerOverCardRef.current = false;
    cancelHoverExplanation();
    cancelHide();
    setOverlay(null);
  };

  const positionNearAnchor = () => {
    const anchor = currentAnchorRef.current;
    const card = cardRef.current;

    if (!anchor?.isConnected || !card) {
      hideExplanation();
      return;
    }

    const anchorRect = getBestShowcaseAnchorRect(anchor, anchorPointRef.current);
    if (!isRectInViewport(anchorRect)) {
      if (lockedRef.current) {
        setOverlay((current) => (current ? { ...current, measuring: false, visible: false } : current));
      } else {
        hideExplanation();
      }
      return;
    }

    const cardRect = card.getBoundingClientRect();
    const left = clamp(anchorRect.left + anchorRect.width / 2 - cardRect.width / 2, 12, Math.max(12, window.innerWidth - cardRect.width - 12));
    const anchorCenterY = anchorRect.top + anchorRect.height / 2;
    initialPlacementRef.current ??= anchorCenterY < window.innerHeight / 2 ? "below" : "above";

    const belowTop = anchorRect.bottom + 10;
    const aboveTop = anchorRect.top - cardRect.height - 10;
    const canFitBelow = belowTop + cardRect.height <= window.innerHeight - 12;
    const canFitAbove = aboveTop >= 12;
    const placement = resolveShowcasePlacement(initialPlacementRef.current, canFitAbove, canFitBelow);
    const top = clamp(placement === "below" ? belowTop : aboveTop, 12, Math.max(12, window.innerHeight - cardRect.height - 12));

    setOverlay((current) => {
      if (!current) {
        return current;
      }

      if (current.left === left && current.top === top && current.visible && !current.measuring) {
        return current;
      }

      return { ...current, left, top, measuring: false, visible: true };
    });
  };

  const scheduleReposition = () => {
    if (!activeTermKeyRef.current) {
      return;
    }
    if (repositionFrameRef.current !== undefined) {
      return;
    }
    repositionFrameRef.current = window.requestAnimationFrame(() => {
      repositionFrameRef.current = undefined;
      positionNearAnchor();
    });
  };

  const showExplanation = (termKey: ShowcaseTermKey, anchor: HTMLButtonElement, pointer: Point | undefined, locked: boolean) => {
    cancelHoverExplanation();
    cancelHide();
    const sameAnchor = currentAnchorRef.current === anchor && activeTermKeyRef.current === termKey;

    if (!sameAnchor) {
      initialPlacementRef.current = undefined;
    }
    currentAnchorRef.current = anchor;
    anchorPointRef.current = pointer;
    lockedRef.current = locked || lockedRef.current;
    activeTermKeyRef.current = termKey;
    if (sameAnchor) {
      setOverlay((current) => (current ? { ...current, locked: locked || current.locked, measuring: false, visible: true } : current));
      scheduleReposition();
      return;
    }

    setOverlay({ termKey, locked, measuring: true, visible: false, left: -9999, top: -9999 });
  };

  const scheduleHide = () => {
    if (lockedRef.current) {
      return;
    }
    cancelHide();
    hideTimerRef.current = window.setTimeout(() => {
      if (pointerOverCardRef.current || currentAnchorRef.current?.matches(":hover")) {
        return;
      }
      hideExplanation();
    }, HIDE_DELAY_MS);
  };

  const scheduleHoverExplanation = (termKey: ShowcaseTermKey, anchor: HTMLButtonElement, pointer: Point) => {
    cancelHoverExplanation();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined;
      if (!anchor.matches(":hover")) {
        return;
      }
      showExplanation(termKey, anchor, pointer, false);
    }, HOVER_SHOW_DELAY_MS);
  };

  const pinCurrentCard = () => {
    lockedRef.current = true;
    cancelHide();
    setOverlay((current) => (current ? { ...current, locked: true } : current));
  };

  useLayoutEffect(() => {
    if (overlay) {
      positionNearAnchor();
    }
  }, [overlay?.termKey, overlay?.measuring, language]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!activeTermKeyRef.current) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (cardRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Element && target.closest(".highlight")) {
        return;
      }
      hideExplanation();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("scroll", scheduleReposition, true);
    document.addEventListener("scroll", scheduleReposition, true);
    window.addEventListener("resize", scheduleReposition);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("scroll", scheduleReposition, true);
      document.removeEventListener("scroll", scheduleReposition, true);
      window.removeEventListener("resize", scheduleReposition);
      cancelHoverExplanation();
      cancelHide();
      if (repositionFrameRef.current !== undefined) {
        window.cancelAnimationFrame(repositionFrameRef.current);
      }
    };
  }, []);

  const renderTerm = (termKey: ShowcaseTermKey) => (
    <Highlighted
      active={overlay?.termKey === termKey && overlay.visible}
      term={terms[termKey]}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        pointerFocusRef.current = false;
        showExplanation(termKey, event.currentTarget, { x: event.clientX, y: event.clientY }, true);
      }}
      onFocus={(event) => {
        if (pointerFocusRef.current) {
          pointerFocusRef.current = false;
          return;
        }
        showExplanation(termKey, event.currentTarget, undefined, false);
      }}
      onBlur={scheduleHide}
      onPointerDown={() => {
        pointerFocusRef.current = true;
      }}
      onPointerEnter={(event) => scheduleHoverExplanation(termKey, event.currentTarget, { x: event.clientX, y: event.clientY })}
      onPointerLeave={() => {
        cancelHoverExplanation();
        scheduleHide();
      }}
    />
  );

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
            <h2 style={{ whiteSpace: "pre-wrap" }}>{t.showcase.title}</h2>
            <p>
              {t.showcase.textStart} {renderTerm("transformer")} {t.showcase.textMiddle}{" "}
              {renderTerm("selfAttention")} {t.showcase.textEnd} {renderTerm("wasm")}, {renderTerm("llm")},{" "}
              {renderTerm("gpu")}.
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
          {activeTerm && overlay ? (
            <aside
              ref={cardRef}
              className={`showcase-overlay-root${overlay.visible ? " is-visible" : ""}${overlay.measuring ? " is-measuring" : ""}`}
              role="tooltip"
              style={{ left: `${overlay.left}px`, top: `${overlay.top}px` }}
              onPointerEnter={() => {
                pointerOverCardRef.current = true;
                cancelHide();
              }}
              onPointerLeave={() => {
                pointerOverCardRef.current = false;
                scheduleHide();
              }}
            >
              <div className="termpop-card">
                <div className="termpop-card-header">
                  <div className="termpop-card-title">{activeTerm.term}</div>
                  <button
                    className="termpop-refresh-button"
                    type="button"
                    title={language === "zh" ? "重新生成解释" : "Regenerate explanation"}
                    aria-label={language === "zh" ? "重新生成解释" : "Regenerate explanation"}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      pinCurrentCard();
                    }}
                  >
                    ↻
                  </button>
                </div>
                <div className="termpop-category">{activeTerm.category}</div>
                <div className="termpop-definition">{activeTerm.definition}</div>
                <div className="termpop-related">
                  {activeTerm.relatedTerms.map((term) => (
                    <span key={term}>{term}</span>
                  ))}
                </div>
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Highlighted({
  active,
  term,
  onBlur,
  onClick,
  onFocus,
  onPointerDown,
  onPointerEnter,
  onPointerLeave
}: {
  active: boolean;
  term: ShowcaseTerm;
  onBlur: () => void;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  onFocus: React.FocusEventHandler<HTMLButtonElement>;
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>;
  onPointerEnter: React.PointerEventHandler<HTMLButtonElement>;
  onPointerLeave: React.PointerEventHandler<HTMLButtonElement>;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`highlight termpop-highlight${active ? " is-active" : ""}`}
      data-term-type={term.termType}
      onBlur={onBlur}
      onClick={onClick}
      onFocus={onFocus}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {term.term}
    </button>
  );
}

function resolveShowcasePlacement(initialPlacement: "above" | "below" | undefined, canFitAbove: boolean, canFitBelow: boolean): "above" | "below" {
  if (initialPlacement === "below") {
    return canFitBelow || !canFitAbove ? "below" : "above";
  }

  return canFitAbove || !canFitBelow ? "above" : "below";
}

function isRectInViewport(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function getBestShowcaseAnchorRect(anchor: HTMLElement, point: Point | undefined): DOMRect {
  const rects = [...anchor.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) {
    return anchor.getBoundingClientRect();
  }

  if (!point) {
    return rects.find(isRectInViewport) ?? rects[0];
  }

  const containingRect = rects.find((rect) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom);
  if (containingRect) {
    return containingRect;
  }

  const visibleRects = rects.filter(isRectInViewport);
  const candidates = visibleRects.length > 0 ? visibleRects : rects;
  return candidates
    .map((rect) => ({
      rect,
      distance: distanceToRect(point, rect)
    }))
    .sort((left, right) => left.distance - right.distance)[0].rect;
}

function distanceToRect(point: Point, rect: DOMRect): number {
  const dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
  const dy = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
  return dx * dx + dy * dy;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function FeatureGrid({ t }: { t: Copy }): React.ReactElement {
  return (
    <section className="section" id="features">
      <div className="section-heading">
        <p className="eyebrow">{t.features.eyebrow}</p>
        <h2 style={{ whiteSpace: "pre-wrap" }}>{t.features.title}</h2>
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
        <h2 style={{ whiteSpace: "pre-wrap" }}>{t.download.title}</h2>
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
