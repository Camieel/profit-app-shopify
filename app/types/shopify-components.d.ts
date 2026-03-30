// app/types/shopify-components.d.ts
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    "s-link": React.DetailedHTMLProps<
      React.AnchorHTMLAttributes<HTMLElement> & { href?: string },
      HTMLElement
    >;
  }
}
