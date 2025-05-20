import csvParser from "csv-parser";
import fs from "fs";
import matter from "gray-matter";
import hljs from "highlight.js";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import path from "path";

import config from "../data/config.json";
import nextConfig from "../next.config.js";
import Positioner from "./positioner";

import { Flag, Item } from "@/lib/types";

const {
  rings,
  chart: { size },
} = config;

const ringIds = rings.map((r) => r.id);
const quadrants = config.quadrants.map((q, i) => ({ ...q, position: i + 1 }));
const quadrantIds = quadrants.map((q) => q.id);
const tags = (config as { tags?: string[] }).tags || [];
const positioner = new Positioner(size, quadrants, rings);

const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang, info) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  }),
);

function dataPath(...paths: string[]): string {
  return path.resolve("data", ...paths);
}

function convertToHtml(markdown: string): string {
  // replace deprecated internal links with .html extension
  markdown = markdown.replace(/(]\(\/[^)]+)\.html/g, "$1/");

  if (nextConfig.basePath) {
    markdown = markdown.replace(/]\(\//g, `](${nextConfig.basePath}/`);
  }

  let html = marked.parse(markdown.trim()) as string;
  html = html.replace(
    /a href="http/g,
    'a target="_blank" rel="noopener noreferrer" href="http',
  );
  return html;
}

function readMarkdownFile(filePath: string): { title: string; body: string } {
  const content = fs.readFileSync(filePath, "utf-8");
  const { data, content: body } = matter(content);
  return {
    title: data.title || "",
    body: convertToHtml(body),
  };
}

function readCsvFile(filePath: string): Promise<Item[]> {
  return new Promise((resolve, reject) => {
    const items: Item[] = [];

    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on("data", (row) => {
        const id = row.title;
        const releaseDate = new Date().toISOString().split("T")[0];
        const body = convertToHtml(row.text || "");

        const item: Item = {
          id,
          release: releaseDate,
          title: row.title || id,
          ring: row.ring,
          quadrant: row.quadrant,
          body: body,
          featured: row.featured !== "false",
          flag: Flag.Default,
          tags: row.tags
            ? row.tags.split(",").map((tag: string) => tag.trim())
            : [],
          position: [0, 0],
        };

        items.push(item);
      })
      .on("end", () => {
        resolve(items.sort((a, b) => a.id.localeCompare(b.id)));
      })
      .on("error", (error) => {
        console.error(`Failed reading CSV file ${filePath}: ${error}`);
        reject(error);
      });
  });
}

// Function to parse the CSV file and return items
async function parseCsvFile(filePath: string): Promise<Item[]> {
  return await readCsvFile(filePath);
}

function getUniqueReleases(items: Item[]): string[] {
  const releases = new Set<string>();
  for (const item of items) {
    releases.add(item.release);
  }
  return Array.from(releases).sort();
}

function getUniqueTags(items: Item[]): string[] {
  const tags = new Set<string>();
  for (const item of items) {
    for (const tag of item.tags) {
      tags.add(tag);
    }
  }
  return Array.from(tags).sort();
}

function getFlag(item: Item, allReleases: string[]): Flag {
  // return default flag if this is the first edition of the radar
  if (allReleases.length === 1) {
    return Flag.Default;
  }

  const latestRelease = allReleases[allReleases.length - 1];
  const isInLatestRelease = item.release === latestRelease;

  if (isInLatestRelease) {
    return Flag.New;
  }

  return Flag.Default;
}

function postProcessItems(items: Item[]): {
  releases: string[];
  tags: string[];
  items: Item[];
} {
  const filteredItems = items.filter((item) => {
    // check if the items' quadrant and ring are valid
    if (!item.quadrant || !item.ring) {
      console.warn(`Item ${item.id} has no quadrant or ring`);
      return false;
    }

    if (!quadrantIds.includes(item.quadrant)) {
      console.warn(`Item ${item.id} has invalid quadrant ${item.quadrant}`);
      return false;
    }

    if (!ringIds.includes(item.ring)) {
      console.warn(`Item ${item.id} has invalid ring ${item.ring}`);
      return false;
    }

    // check if config has a key `tags` and if it is an array
    if (Array.isArray(tags) && tags.length) {
      // if tags are specified, only keep items that have at least one of the tags
      return item.tags.some((tag) => tags.includes(tag));
    }

    return true;
  });

  const releases = getUniqueReleases(filteredItems);
  const uniqueTags = getUniqueTags(filteredItems);
  const processedItems = filteredItems.map((item) => {
    return {
      ...item,
      position: positioner.getNextPosition(item.quadrant, item.ring),
      flag: getFlag(item, releases),
    };
  });

  return { releases, tags: uniqueTags, items: processedItems };
}

// Parse the data and write radar data to JSON file
readCsvFile(dataPath("techradar-data.csv")).then((items) => {
  const data = postProcessItems(items);
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(dataPath("data.json"), json);
});

// write about data to JSON file
const about = readMarkdownFile(dataPath("about.md"));
fs.writeFileSync(dataPath("about.json"), JSON.stringify(about, null, 2));
