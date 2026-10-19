import { Node, mergeAttributes } from "@tiptap/core";

export const ASSET_SCHEME = "niho-docs-asset:";
const ASSET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}\.(?:jpg|jpeg|png|webp)$/;

export function assetName(source: string): string | null {
  if (!source.startsWith(ASSET_SCHEME)) return null;
  const name = source.slice(ASSET_SCHEME.length);
  return ASSET_NAME.test(name) ? name : null;
}

/**
 * 案件の画像だけを描く。src は保存した参照のまま、表示時だけ options.resolve（Mac は bridge、Web は保管庫）で data URL に解決する。
 * HTML から読むとき（貼り付け）の alt・title は、TipTap が addAttributes の名前の属性を読んで上書きするので、Mac・Web のどちらの
 * 旧実装（name だけを返す形と、name・alt・title を返す形）とも同じ attrs になる。
 */
export const DocAssetImage = Node.create<{ resolve: (name: string) => Promise<string> }>({
  name: "docAssetImage",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions() {
    return { resolve: async () => "" };
  },
  addAttributes() {
    return { name: { default: "" }, alt: { default: "" }, title: { default: null } };
  },
  parseHTML() {
    return [{ tag: "img[data-doc-asset]", getAttrs: (element) => {
      const image = element as HTMLImageElement;
      return { name: image.dataset.docAsset ?? "", alt: image.getAttribute("alt") ?? "", title: image.getAttribute("title") };
    } }];
  },
  renderHTML({ HTMLAttributes }) {
    const { name, alt, title } = HTMLAttributes;
    return ["img", mergeAttributes({ "data-doc-asset": name, alt: alt || "画像", title })];
  },
  addNodeView() {
    return ({ node }) => {
      const image = document.createElement("img");
      const name = String(node.attrs.name ?? "");
      image.alt = String(node.attrs.alt ?? "");
      image.title = String(node.attrs.title ?? "");
      image.dataset.docAsset = name;
      if (ASSET_NAME.test(name)) {
        void this.options.resolve(name).then((source) => {
          if (source.startsWith("data:image/")) image.src = source;
        }).catch(() => {
          image.alt = `${image.alt || "画像"}（読み込めませんでした）`;
        });
      }
      return { dom: image };
    };
  },
});
