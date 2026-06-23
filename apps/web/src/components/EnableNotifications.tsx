'use client'
import { usePushNotifications } from "../hooks/usePushNotifications";
import { Button } from "@/components/ui/button";

export function EnableNotifications({ token }: { token: string }) {
  const { status, enable } = usePushNotifications(token);

  if (status === "unsupported") return null;
  if (status === "granted") return null;
  if (status === "not-installed") {
    return <p className="text-xs text-muted-foreground px-2">Add to Home Screen to enable notifications.</p>;
  }
  if (status === "denied") {
    return <p className="text-xs text-muted-foreground px-2">Notifications blocked in Settings.</p>;
  }
  return (
    <Button size="sm" variant="outline" onClick={() => void enable()}>
      Enable notifications
    </Button>
  );
}
