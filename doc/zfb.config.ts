import { defineConfig } from "zfb/config";
import { zudoDoc } from "@takazudo/zudo-doc/config";

export default defineConfig(
  zudoDoc({
    themePack: "drift",
    siteName: "Doc",
    locales: {
      ja: {
        label: "JA",
        dir: "src/content/docs-ja",
      },
    },
    metaTags: {
      description: true,
      keywords: "",
      ogImage: "/img/ogp.png",
      ogSiteName: true,
      twitterCard: false,
    },
    llmsTxt: true,
    cjkFriendly: true,
    sidebarResizer: true,
    sidebarToggle: true,
    tocToggle: true,
    imageEnlarge: true,
    dynamicPageTransition: true,
    docHistory: true,
    claudeResources: {
      claudeDir: "../.claude",
      // Keep generated pages under doc/ while scanning the repository root.
      projectRoot: ".",
      scanRoot: "..",
    },
    defaultLocaleOnlyPrefixes: [
      "/docs/claude-md/",
      "/docs/claude-skills/",
      "/docs/claude-agents/",
      "/docs/claude-commands/",
    ],
    footer: {
      links: [],
      copyright: "Copyright © 2026 Your Name. Built with zudo-doc.",
    },
    headerNav: [
      {
        label: "Getting Started",
        path: "/docs/getting-started",
        categoryMatch: "getting-started",
      },
      {
        label: "Claude",
        path: "/docs/claude",
        categoryMatch: "claude",
      },
    ],
    headerRightItems: [
      {
        type: "component",
        component: "github-link",
      },
      {
        type: "component",
        component: "theme-toggle",
      },
      {
        type: "component",
        component: "search",
      },
      {
        type: "component",
        component: "language-switcher",
      },
    ],
  }),
);
