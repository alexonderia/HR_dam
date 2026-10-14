declare module "rtf-parser" {
  interface Node {
    value?: string;
    content?: Node[];
  }
  const parser: {
    string(
      input: string,
      callback: (error: Error | null, document: Node) => void,
    ): void;
  };
  export default parser;
}
