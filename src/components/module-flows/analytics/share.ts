// The browser side of an Analytics report's "Share" step: a clipboard write, a
// file download and a print of a standalone page. Each says whether it worked
// and none throws. Client only (they touch the DOM when called).

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadText(
  fileName: string,
  text: string,
  type: string,
): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Some browsers read the file after click() returns.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

const PRINT_FRAME_ID = "analytics-report-print";

// Prints a standalone page from a hidden frame, so only the report reaches the
// printer (never the app around it); "Save as PDF" is the browser's own print
// destination. The frame has a real size off screen: some browsers print an
// empty page from a zero-sized one. It stays until the next print replaces it,
// because removing it while a print dialog is open cancels the print.
export function printHtml(html: string): boolean {
  try {
    document.getElementById(PRINT_FRAME_ID)?.remove();
    const frame = document.createElement("iframe");
    frame.id = PRINT_FRAME_ID;
    frame.title = PRINT_FRAME_ID;
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    Object.assign(frame.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "800px",
      height: "1100px",
      border: "0",
    });
    frame.addEventListener("load", () => {
      const view = frame.contentWindow;
      // Some browsers announce the frame's empty first page too: only the
      // report itself is printed.
      if (!view || !view.document.querySelector("header")) return;
      view.focus();
      view.print();
    });
    frame.srcdoc = html;
    document.body.appendChild(frame);
    return true;
  } catch {
    return false;
  }
}
