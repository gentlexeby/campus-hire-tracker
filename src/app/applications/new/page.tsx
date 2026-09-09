import type { Metadata } from "next";
import Link from "next/link";
import { NewApplicationForm } from "@/components/forms";
import { PageHeader, Section } from "@/components/ui";
import { createApplicationAction } from "@/app/actions";

export const metadata: Metadata = { title: "新建申请" };

export default function NewApplicationPage() {
  return (
    <div className="narrow-page">
      <Link className="detail-breadcrumb" href="/applications">← 返回申请</Link>
      <PageHeader
        eyebrow="快速记录"
        title="新建岗位申请"
        description="先记下公司和岗位就够了。没有设置下一步时，它会明确进入今日的待补队列。"
      />
      <Section>
        <NewApplicationForm action={createApplicationAction} />
      </Section>
      <p className="privacy-footnote">数据只写入此 Windows 账户的本地数据目录，不会上传或同步。</p>
    </div>
  );
}
