"use client";

import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  Bell,
  FileText,
  Megaphone,
  Package,
  Bot,
  PartyPopper,
  ShoppingBag,
  BarChart3,
  GraduationCap,
  Receipt,
  Truck,
  Radio,
  Gauge,
  Zap,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  "/dashboard": LayoutDashboard,
  "/dashboard/agent": Bot,
  "/dashboard/clients": Users,
  "/dashboard/conversations": MessageSquare,
  "/dashboard/quick-replies": Zap,
  "/dashboard/reminders": Bell,
  "/dashboard/templates": FileText,
  "/dashboard/broadcasts": Megaphone,
  "/dashboard/products": Package,
  "/dashboard/delivery-rules": Truck,
  "/dashboard/events": PartyPopper,
  "/dashboard/orders": ShoppingBag,
  "/dashboard/visitors": Radio,
  "/dashboard/usage": Gauge,
  "/dashboard/analytics": BarChart3,
  "/dashboard/training": GraduationCap,
  "/dashboard/billing": Receipt,
};

export type NavItem = { href: string; label: string };

export default function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-1">
      {items.map((item) => {
        const Icon = ICONS[item.href] ?? LayoutDashboard;
        const isActive =
          item.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname === item.href || pathname?.startsWith(item.href + "/");

        return (
          <a
            key={item.href}
            href={item.href}
            className={`flex items-center gap-2 rounded-lg px-2 py-2 text-[13px] transition-colors ${
              isActive
                ? "bg-white/15 text-white font-medium"
                : "text-white/70 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Icon size={16} strokeWidth={2} className="flex-shrink-0" />
            <span className="truncate">{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
