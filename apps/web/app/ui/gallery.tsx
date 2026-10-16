"use client";

// DEVELOPER PAGE, not user-facing: the words here are samples for looking at components, not product text.
import { useState } from "react";
import {
  ALERT_CATEGORY_NAMES,
  Button,
  Card,
  CardRow,
  CategoryBadge,
  HoldToConfirm,
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
  setThemePreference,
  useToast,
  type PaymentMethod,
} from "@retail/ui";

function Toaster() {
  const toast = useToast();
  return <Button label="Show a message" icon="bell" variant="secondary" onClick={() => toast.show({ message: "Saved", tone: "ok" })} />;
}

export function Gallery() {
  const [amount, setAmount] = useState("");
  const [sheet, setSheet] = useState(false);
  const [confirmed, setConfirmed] = useState(0);
  const [submitted, setSubmitted] = useState("");

  return (
    <ToastProvider dismissLabel="Dismiss">
      <main className="ui-page ui-stack" data-testid="gallery">
        <h1>Components</h1>

        <div className="ui-stack">
          <h2>Theme</h2>
          <div className="ui-grid">
            <Button label="Light" variant="secondary" onClick={() => setThemePreference("light")} />
            <Button label="Dark" variant="secondary" onClick={() => setThemePreference("dark")} />
          </div>
        </div>

        <div className="ui-grid" data-wide="4">
          <Tile value="32" label="Total people" tone="a" trend={{ direction: "up", text: "11 more than last session" }} />
          <Tile value="32" label="Regular" tone="b" trend={{ direction: "flat", text: "same as last session" }} />
          <Tile value="0" label="Guest" tone="c" trend={{ direction: "down", text: "2 fewer than yesterday" }} />
          <Tile value="0" label="Volunteer" tone="d" />
        </div>

        <ModuleHeading module="inventory">Inventory</ModuleHeading>

        <Card title="Locations" accent="var(--cat-suspicion-fg)" footer={<span>Total 31</span>}>
          <CardRow count="12" label="Red Wing">
            <span>12 in</span>
          </CardRow>
          <CardRow count="0" label="Elephants" />
        </Card>

        <div className="ui-stack">
          <h2>Payment methods</h2>
          <div className="ui-grid">
            {(Object.keys(PAYMENT_METHODS) as PaymentMethod[]).map((method) => (
              <PaymentChip key={method} method={method} label={method} />
            ))}
          </div>
        </div>

        <div className="ui-grid">
          {ALERT_CATEGORY_NAMES.map((category) => (
            <CategoryBadge key={category} category={category} label={category} />
          ))}
        </div>

        <Tabs
          ariaLabel="Views"
          tabs={[
            { id: "low", label: "Low stock", panel: <p>Low stock view</p> },
            { id: "disc", label: "Discounted", panel: <p>Discounted view</p> },
            { id: "all", label: "All", panel: <p>All view</p> },
          ]}
        />

        <div className="ui-stack">
          <h2>Amount</h2>
          <output aria-label="amount" data-testid="amount">
            {amount || "0"}
          </output>
          <Keypad value={amount} onChange={setAmount} backspaceLabel="Delete" />
        </div>

        <div className="ui-stack">
          <h2>PIN</h2>
          <PinPad onSubmit={setSubmitted} labels={{ confirm: "Confirm", backspace: "Delete PIN digit", entered: (n) => `${n} digits entered` }} />
          <output data-testid="submitted">{submitted ? `PIN received (${submitted.length} digits)` : "none"}</output>
        </div>

        <div className="ui-stack">
          <h2>Confirm</h2>
          <HoldToConfirm label="Hold to pay" holdingLabel="Keep holding" onConfirm={() => setConfirmed((n) => n + 1)} />
          <output data-testid="confirmed">{confirmed}</output>
        </div>

        <div className="ui-stack">
          <h2>Buttons</h2>
          <Button label="Pay" icon="check" size="lg" />
          <Button label="Cancel" variant="secondary" />
          <Button label="Delete" variant="danger" icon="close" />
          <Button label="Saving" loading />
          <Button label="Open panel" variant="ghost" icon="menu" onClick={() => setSheet(true)} />
          <Toaster />
        </div>

        <div className="ui-stack" aria-busy="true">
          <h2>Loading</h2>
          <Skeleton width="8rem" height="2rem" />
          <SkeletonText lines={3} />
        </div>

        <Sheet open={sheet} onClose={() => setSheet(false)} title="Product" closeLabel="Close">
          <p>Details open without leaving the list.</p>
          <Button label="Save" icon="check" onClick={() => setSheet(false)} />
        </Sheet>
      </main>
    </ToastProvider>
  );
}
