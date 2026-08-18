import { Hero } from "@/components/marketing/home/hero";
import { AppKanbanShowcase } from "@/components/marketing/home/app-kanban-showcase";
import { StopManagingAi } from "@/components/marketing/home/stop-managing-ai";
import { HowItWorks } from "@/components/marketing/home/how-it-works";
import { BrandBrain } from "@/components/marketing/home/brand-brain";
import { Departments } from "@/components/marketing/home/departments";
import { ProactiveAi } from "@/components/marketing/home/proactive-ai";
import { AppChatShowcase } from "@/components/marketing/home/app-chat-showcase";
import { ProductExperience } from "@/components/marketing/home/product-experience";
import { HumanControl } from "@/components/marketing/home/human-control";
import { Integrations } from "@/components/marketing/home/integrations";
import { MultiBrand } from "@/components/marketing/home/multi-brand";
import { TrustSecurity } from "@/components/marketing/home/trust-security";
import { PricingSection } from "@/components/marketing/pricing-section";
import { FinalCta } from "@/components/marketing/final-cta";

export default function MarketingHomePage() {
  return (
    <>
      <Hero />
      <AppKanbanShowcase />
      <StopManagingAi />
      <HowItWorks />
      <BrandBrain />
      <Departments />
      <ProactiveAi />
      <AppChatShowcase />
      <ProductExperience />
      <HumanControl />
      <Integrations />
      <MultiBrand />
      <PricingSection variant="compact" />
      <TrustSecurity />
      <FinalCta />
    </>
  );
}
