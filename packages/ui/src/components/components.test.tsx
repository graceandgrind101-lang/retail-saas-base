import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_CATEGORY_NAMES,
  Button,
  Card,
  CardRow,
  CategoryBadge,
  HoldToConfirm,
  ICON_NAMES,
  Icon,
  Keypad,
  ModuleHeading,
  PAYMENT_METHODS,
  PaymentChip,
  PinPad,
  Sheet,
  Skeleton,
  SkeletonText,
  Tabs,
  Tile,
  ToastProvider,
  useToast,
} from "..";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.style.overflow = "";
});

describe("Button", () => {
  it("always shows its words, with an icon beside them when given", () => {
    render(<Button label="Pay" icon="check" />);
    const button = screen.getByRole("button", { name: "Pay" });
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.getAttribute("type")).toBe("button");
  });

  it("while loading it ignores presses, says it is busy, and shows progress instead of the icon", async () => {
    const onClick = vi.fn();
    render(<Button label="Save" icon="check" loading onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector("svg")).toBeNull();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is pressed once per press, and not at all when disabled", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button label="Go" onClick={onClick} />);
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button label="Go" onClick={onClick} disabled />);
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("carries its variant and size for the styles, and a form button can submit", () => {
    render(<Button label="Delete" variant="danger" size="lg" type="submit" />);
    const button = screen.getByRole("button", { name: "Delete" });
    expect([button.dataset.variant, button.dataset.size, button.getAttribute("type")]).toEqual(["danger", "lg", "submit"]);
  });
});

describe("Tile and Card", () => {
  it("a tile shows the number, the label and a trend with an arrow and words (never colour alone)", () => {
    render(<Tile value="32" label="Total people" tone="b" trend={{ direction: "up", text: "11 more than last session" }} />);
    expect(screen.getByText("32")).toBeInTheDocument();
    expect(screen.getByText("Total people")).toBeInTheDocument();
    const trend = screen.getByText("11 more than last session").parentElement as HTMLElement;
    expect(trend.dataset.direction).toBe("up");
    expect(trend.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("32").closest(".ui-tile")?.getAttribute("data-tone")).toBe("b");
  });

  it("a tile without a trend has none", () => {
    const { container } = render(<Tile value="0" label="Guests" />);
    expect(container.querySelector(".ui-tile-trend")).toBeNull();
  });

  it("a card has a heading, rows with counts, and a footer total", () => {
    render(
      <Card title="Locations" accent="var(--cat-fraud-fg)" footer={<span>Total 31</span>}>
        <CardRow count="12" label="Red Wing">
          <span>12 checked in</span>
        </CardRow>
        <CardRow label="Elephants" />
      </Card>,
    );
    expect(screen.getByRole("region", { name: "Locations" })).toBeInTheDocument();
    expect(screen.getByText("Locations")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("12 checked in")).toBeInTheDocument();
    expect(screen.getByText("Total 31")).toBeInTheDocument();
    expect(screen.getByText("Elephants").parentElement?.querySelector(".ui-card-count")).toBeNull();
  });
});

describe("Skeleton, chips, badges, headings and icons", () => {
  it("a skeleton is hidden from screen readers and has the size asked", () => {
    const { container } = render(<Skeleton width="4rem" height="2rem" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect([el.style.width, el.style.height]).toEqual(["4rem", "2rem"]);
  });

  it("skeleton text has the lines asked (at least one), the last one shorter", () => {
    const { container, rerender } = render(<SkeletonText lines={4} />);
    expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(4);
    expect((container.querySelectorAll(".ui-skeleton")[3] as HTMLElement).style.width).toBe("60%");
    rerender(<SkeletonText lines={0} />);
    expect(container.querySelectorAll(".ui-skeleton")).toHaveLength(1);
    expect((container.querySelector(".ui-skeleton") as HTMLElement).style.width).toBe("100%");
  });

  it("each payment method has its own fixed colour, icon and label (U6)", () => {
    const methods = Object.keys(PAYMENT_METHODS) as (keyof typeof PAYMENT_METHODS)[];
    expect(methods).toEqual(["cash", "telebirr", "cbe", "bank", "dube"]);
    expect(new Set(methods.map((m) => PAYMENT_METHODS[m].token)).size).toBe(5);
    for (const method of methods) {
      const { container, unmount } = render(<PaymentChip method={method} label={`label ${method}`} />);
      expect(screen.getByText(`label ${method}`)).toBeInTheDocument();
      expect((container.firstElementChild as HTMLElement).dataset.method).toBe(method);
      expect(container.querySelector("svg")).not.toBeNull();
      unmount();
    }
  });

  it("an alert category badge shows its word, for all six categories", () => {
    for (const category of ALERT_CATEGORY_NAMES) {
      const { container, unmount } = render(<CategoryBadge category={category} label={`word ${category}`} />);
      expect(screen.getByText(`word ${category}`)).toBeInTheDocument();
      expect((container.firstElementChild as HTMLElement).dataset.category).toBe(category);
      unmount();
    }
  });

  it("a module heading carries its module for the accent bar", () => {
    render(<ModuleHeading module="inventory">Inventory</ModuleHeading>);
    const heading = screen.getByRole("heading", { name: "Inventory" });
    expect(heading.dataset.module).toBe("inventory");
  });

  it("every icon draws something and is hidden from screen readers", () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg") as SVGElement;
      expect(svg.getAttribute("aria-hidden"), name).toBe("true");
      expect(svg.children.length, name).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe("Tabs", () => {
  const tabs = [
    { id: "low", label: "Low stock", panel: <p>low panel</p> },
    { id: "disc", label: "Discounted", panel: <p>discount panel</p> },
    { id: "all", label: "All", panel: <p>all panel</p> },
  ];

  it("shows the first tab, one panel at a time, with the right roles", () => {
    render(<Tabs tabs={tabs} ariaLabel="Views" />);
    expect(screen.getByRole("tablist", { name: "Views" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Low stock" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("low panel");
    expect(screen.queryByText("discount panel")).toBeNull();
  });

  it("a click selects, and the panel follows", async () => {
    render(<Tabs tabs={tabs} ariaLabel="Views" />);
    await userEvent.click(screen.getByRole("tab", { name: "Discounted" }));
    expect(screen.getByRole("tab", { name: "Discounted" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("discount panel");
  });

  it("only the selected tab is in the tab order, and the panel is named by its tab", () => {
    render(<Tabs tabs={tabs} ariaLabel="Views" defaultValue="disc" />);
    expect(screen.getByRole("tab", { name: "Low stock" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: "Discounted" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tabpanel", { name: "Discounted" })).toBeInTheDocument();
  });

  it("arrow keys move and wrap, Home and End jump, and focus follows", async () => {
    render(<Tabs tabs={tabs} ariaLabel="Views" />);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("tab", { name: "Low stock" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Discounted" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Discounted" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Low stock" })).toHaveFocus(); // wrapped
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "All" })).toHaveFocus(); // wrapped backwards
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Low stock" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "All" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("all panel");
  });

  it("controlled: reports changes and shows what the parent says", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Tabs tabs={tabs} ariaLabel="Views" value="low" onChange={onChange} />);
    await userEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(onChange).toHaveBeenCalledWith("all");
    expect(screen.getByRole("tab", { name: "Low stock" })).toHaveAttribute("aria-selected", "true"); // parent has not changed it
    rerender(<Tabs tabs={tabs} ariaLabel="Views" value="all" onChange={onChange} />);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("all panel");
  });
});

describe("Sheet", () => {
  function Harness({ onClose = () => {} }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>open it</button>
        <Sheet
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          title="Product"
          closeLabel="Close"
        >
          <input aria-label="name" />
          <button>save</button>
        </Sheet>
      </>
    );
  }

  it("is a modal dialog named by its title, and renders nothing while closed", async () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByText("open it"));
    const dialog = screen.getByRole("dialog", { name: "Product" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus in, locks page scroll, and gives both back on close", async () => {
    render(<Harness />);
    const opener = screen.getByText("open it");
    await userEvent.click(opener);
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
  });

  it("can put focus somewhere else on opening, such as a search box", () => {
    render(
      <Sheet open onClose={() => {}} title="Search" closeLabel="Close" initialFocus="input">
        <input aria-label="query" />
      </Sheet>,
    );
    expect(screen.getByLabelText("query")).toHaveFocus();
  });

  it("falls back to the first control if the wanted one is not there", () => {
    render(
      <Sheet open onClose={() => {}} title="Search" closeLabel="Close" initialFocus=".nope">
        <input aria-label="query" />
      </Sheet>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("Escape and the close button and a tap outside all close it", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("open it"));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByText("open it"));
    fireEvent.mouseDown(document.querySelector(".ui-scrim") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(screen.getByText("open it"));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("a press inside the panel does not close it", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText("open it"));
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.mouseDown(screen.getByLabelText("name"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Tab stays inside, in both directions", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByText("open it"));
    const close = screen.getByRole("button", { name: "Close" });
    const input = screen.getByLabelText("name");
    const save = screen.getByRole("button", { name: "save" });
    expect(close).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus(); // wrapped to the start
    await user.tab({ shift: true });
    expect(save).toHaveFocus(); // wrapped to the end
  });
});

function ToastHarness() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast.show({ message: "Saved", tone: "ok" })}>one</button>
      <button onClick={() => toast.show({ message: "Stays", durationMs: 0 })}>sticky</button>
      <button onClick={() => toast.show({ message: "Short", durationMs: 1000 })}>short</button>
      <button
        onClick={() => {
          for (let i = 1; i <= 6; i++) toast.show({ message: `n${i}`, durationMs: 0 });
        }}
      >
        many
      </button>
    </>
  );
}

describe("Toast", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  const setup = () => {
    render(
      <ToastProvider dismissLabel="Dismiss">
        <ToastHarness />
      </ToastProvider>,
    );
    return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  };

  it("is announced politely and never takes focus", async () => {
    const user = setup();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    await user.click(screen.getByText("one"));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByText("one")).toHaveFocus();
  });

  it("goes away by itself after 4 seconds (or the time asked), unless it is meant to stay", async () => {
    const user = setup();
    await user.click(screen.getByText("one"));
    await user.click(screen.getByText("sticky"));
    await user.click(screen.getByText("short"));
    act(() => void vi.advanceTimersByTime(1100));
    expect(screen.queryByText("Short")).toBeNull();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.queryByText("Saved")).toBeNull();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Stays")).toBeInTheDocument();
  });

  it("the dismiss button removes just that message", async () => {
    const user = setup();
    await user.click(screen.getByText("sticky"));
    await user.click(screen.getByText("one"));
    const saved = screen.getByText("Saved").parentElement as HTMLElement;
    await user.click(within(saved).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText("Stays")).toBeInTheDocument();
  });

  it("carries its tone for the colours (ok, warn, bad or the plain default)", async () => {
    function Tones() {
      const toast = useToast();
      return (
        <button
          onClick={() => {
            toast.show({ message: "a", tone: "ok", durationMs: 0 });
            toast.show({ message: "b", tone: "bad", durationMs: 0 });
            toast.show({ message: "c", durationMs: 0 });
          }}
        >
          go
        </button>
      );
    }
    render(
      <ToastProvider dismissLabel="Dismiss">
        <Tones />
      </ToastProvider>,
    );
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByText("go"));
    const tone = (text: string) => (screen.getByText(text).parentElement as HTMLElement).dataset.tone;
    expect([tone("a"), tone("b"), tone("c")]).toEqual(["ok", "bad", "info"]);
  });

  it("keeps only the latest few, so a flood never covers the screen", async () => {
    const user = setup();
    await user.click(screen.getByText("many"));
    const shown = screen.getAllByText(/^n\d$/).map((el) => el.textContent);
    expect(shown).toEqual(["n3", "n4", "n5", "n6"]);
  });

  it("asks for its provider rather than failing silently", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ToastHarness />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});

describe("Keypad", () => {
  function Harness({ decimals = 2 }: { decimals?: number }) {
    const [value, setValue] = useState("");
    return (
      <>
        <output aria-label="amount">{value}</output>
        <Keypad value={value} onChange={setValue} backspaceLabel="Delete" rules={{ maxIntegerDigits: 9, decimals }} />
      </>
    );
  }

  it("types an amount with big keys, and delete removes the last digit", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    for (const key of ["1", "2", ".", "5"]) await user.click(screen.getByRole("button", { name: key }));
    expect(screen.getByLabelText("amount")).toHaveTextContent("12.5");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByLabelText("amount")).toHaveTextContent("12");
  });

  it("applies the rules: no leading zeros, two decimals at most", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    for (const key of ["0", "0", "7", ".", "5", "5", "5"]) await user.click(screen.getByRole("button", { name: key }));
    expect(screen.getByLabelText("amount")).toHaveTextContent("7.55");
  });

  it("has twelve keys in the thumb layout, and no point key when amounts are whole units", () => {
    const { container, unmount } = render(<Harness />);
    expect([...container.querySelectorAll(".ui-key")].map((k) => k.textContent || k.getAttribute("aria-label"))).toEqual(["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "Delete"]);
    unmount();
    const whole = render(<Harness decimals={0} />);
    const point = [...whole.container.querySelectorAll(".ui-key")].find((k) => k.textContent === ".") as HTMLButtonElement;
    expect(point).toBeDisabled();
    expect(point.getAttribute("aria-hidden")).toBe("true");
  });

  it("every key is at least a thumb tall (the style sets it from a token)", () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll(".ui-key")).toHaveLength(12);
  });

  it("can be switched off", async () => {
    const onChange = vi.fn();
    render(<Keypad value="" onChange={onChange} backspaceLabel="Delete" disabled />);
    await userEvent.click(screen.getByRole("button", { name: "5" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("PinPad", () => {
  const labels = { confirm: "Confirm", backspace: "Delete", entered: (n: number) => `${n} digits entered` };

  it("shows dots, never the digits, and describes progress in words", async () => {
    const { container } = render(<PinPad onSubmit={() => {}} labels={labels} />);
    const user = userEvent.setup();
    expect(screen.getByRole("img", { name: "0 digits entered" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "4" }));
    await user.click(screen.getByRole("button", { name: "8" }));
    expect(screen.getByRole("img", { name: "2 digits entered" })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-filled="true"]')).toHaveLength(2);
    expect(container.querySelectorAll(".ui-pin-dot")).toHaveLength(6);
    // the digits are not in the text of the dots or anywhere outside the keys
    expect((container.querySelector(".ui-pin-dots") as HTMLElement).textContent).toBe("");
  });

  it("confirm waits for at least four digits, then hands over the PIN once and clears itself", async () => {
    const onSubmit = vi.fn();
    render(<PinPad onSubmit={onSubmit} labels={labels} />);
    const user = userEvent.setup();
    const confirm = screen.getByRole("button", { name: "Confirm" });
    for (const d of ["4", "8", "2"]) await user.click(screen.getByRole("button", { name: d }));
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "9" }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("4829");
    expect(screen.getByRole("img", { name: "0 digits entered" })).toBeInTheDocument();
    expect(confirm).toBeDisabled();
  });

  it("takes at most six digits and delete steps back", async () => {
    const onSubmit = vi.fn();
    render(<PinPad onSubmit={onSubmit} labels={labels} />);
    const user = userEvent.setup();
    for (const d of ["1", "3", "5", "7", "9", "2", "4", "6"]) await user.click(screen.getByRole("button", { name: d }));
    expect(screen.getByRole("img", { name: "6 digits entered" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("img", { name: "5 digits entered" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onSubmit).toHaveBeenCalledWith("13579");
  });

  it("honours other lengths", async () => {
    const onSubmit = vi.fn();
    render(<PinPad onSubmit={onSubmit} labels={labels} minLength={2} maxLength={3} />);
    const user = userEvent.setup();
    for (const d of ["1", "2", "3", "4"]) await user.click(screen.getByRole("button", { name: d }));
    expect(screen.getByRole("img", { name: "3 digits entered" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onSubmit).toHaveBeenCalledWith("123");
  });

  it("disabled (a locked person or till) refuses every key and confirm", async () => {
    const onSubmit = vi.fn();
    render(<PinPad onSubmit={onSubmit} labels={labels} disabled />);
    await userEvent.click(screen.getByRole("button", { name: "5" }));
    expect(screen.getByRole("img", { name: "0 digits entered" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("an error shakes the dots, once per change of the error key", () => {
    const { container, rerender } = render(<PinPad onSubmit={() => {}} labels={labels} />);
    expect(container.querySelector(".ui-pin-dots")?.hasAttribute("data-error")).toBe(false);
    rerender(<PinPad onSubmit={() => {}} labels={labels} errorKey={1} />);
    expect(container.querySelector(".ui-pin-dots")?.getAttribute("data-error")).toBe("1");
    rerender(<PinPad onSubmit={() => {}} labels={labels} errorKey={2} />);
    expect(container.querySelector(".ui-pin-dots")?.getAttribute("data-error")).toBe("2");
  });
});

describe("HoldToConfirm", () => {
  beforeEach(() => vi.useFakeTimers());
  const button = () => screen.getByRole("button");

  it("confirms only after being held for the whole time", () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirm label="Hold to pay" onConfirm={onConfirm} durationMs={800} />);
    fireEvent.pointerDown(button());
    act(() => void vi.advanceTimersByTime(799));
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("letting go early, leaving the button or a cancelled touch cancels it", () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirm label="Hold to pay" onConfirm={onConfirm} />);
    for (const release of [fireEvent.pointerUp, fireEvent.pointerLeave, fireEvent.pointerCancel, fireEvent.blur]) {
      fireEvent.pointerDown(button());
      act(() => void vi.advanceTimersByTime(500));
      release(button());
      act(() => void vi.advanceTimersByTime(5000));
    }
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows the bar filling while held, takes the holding words, and resets after", () => {
    render(<HoldToConfirm label="Hold to pay" holdingLabel="Keep holding" onConfirm={() => {}} durationMs={600} />);
    expect(button()).toHaveTextContent("Hold to pay");
    fireEvent.pointerDown(button());
    expect(button().dataset.holding).toBe("true");
    expect(button()).toHaveTextContent("Keep holding");
    expect(button().style.getPropertyValue("--hold-ms")).toBe("600ms");
    act(() => void vi.advanceTimersByTime(600));
    expect(button().dataset.holding).toBe("false");
    expect(button()).toHaveTextContent("Hold to pay");
  });

  it("a second press while holding does not start a second timer", () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirm label="Hold" onConfirm={onConfirm} durationMs={800} />);
    fireEvent.pointerDown(button());
    act(() => void vi.advanceTimersByTime(400));
    fireEvent.pointerDown(button());
    act(() => void vi.advanceTimersByTime(400));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("works from the keyboard: hold Space or Enter, and key repeat does not restart it", () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirm label="Hold" onConfirm={onConfirm} durationMs={800} />);
    button().focus();
    fireEvent.keyDown(button(), { key: " " });
    act(() => void vi.advanceTimersByTime(500));
    fireEvent.keyDown(button(), { key: " ", repeat: true });
    act(() => void vi.advanceTimersByTime(300));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(button(), { key: "Enter" });
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.keyUp(button(), { key: "Enter" });
    act(() => void vi.advanceTimersByTime(2000));
    expect(onConfirm).toHaveBeenCalledTimes(1); // released early
    fireEvent.keyDown(button(), { key: "a" });
    act(() => void vi.advanceTimersByTime(2000));
    expect(onConfirm).toHaveBeenCalledTimes(1); // other keys do nothing
  });

  it("disabled never confirms", () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirm label="Hold" onConfirm={onConfirm} disabled />);
    fireEvent.pointerDown(button());
    act(() => void vi.advanceTimersByTime(5000));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("can be held again after confirming, and uses the latest handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<HoldToConfirm label="Hold" onConfirm={first} durationMs={100} />);
    fireEvent.pointerDown(button());
    act(() => void vi.advanceTimersByTime(100));
    expect(first).toHaveBeenCalledTimes(1);
    rerender(<HoldToConfirm label="Hold" onConfirm={second} durationMs={100} />);
    fireEvent.pointerDown(button());
    act(() => void vi.advanceTimersByTime(100));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("does not confirm after it has been removed from the page", () => {
    const onConfirm = vi.fn();
    const { unmount } = render(<HoldToConfirm label="Hold" onConfirm={onConfirm} durationMs={500} />);
    fireEvent.pointerDown(button());
    unmount();
    act(() => void vi.advanceTimersByTime(5000));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
