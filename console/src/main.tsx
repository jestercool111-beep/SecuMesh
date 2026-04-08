import React from 'react';
import ReactDOM from 'react-dom/client';
import { App, Card, Layout, Menu, Typography } from 'antd';

const items = [
  { key: 'overview', label: '租户概览' },
  { key: 'keys', label: 'API Keys' },
  { key: 'usage', label: '用量统计' },
  { key: 'audit', label: '审计日志' },
  { key: 'upstreams', label: '上游配置' },
];

function Root() {
  return (
    <App>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Sider theme='light' width={240} style={{ borderRight: '1px solid #eef2f6' }}>
          <div style={{ padding: 20, fontWeight: 700, fontSize: 18 }}>SecuMesh Console</div>
          <Menu mode='inline' defaultSelectedKeys={['overview']} items={items} />
        </Layout.Sider>
        <Layout>
          <Layout.Header
            style={{
              background: 'linear-gradient(90deg, #0f766e 0%, #0369a1 100%)',
              color: '#fff',
              fontSize: 18,
              fontWeight: 600,
            }}
          >
            企业 AI 访问管理平台
          </Layout.Header>
          <Layout.Content style={{ padding: 24, background: '#f7fafc' }}>
            <Card bordered={false} style={{ borderRadius: 20 }}>
              <Typography.Title level={3}>MVP Console Scaffold</Typography.Title>
              <Typography.Paragraph>
                这一版控制台先作为最小管理平台骨架，后续将接入租户概览、API Key 管理、用量统计、
                审计查询和上游配置等页面。
              </Typography.Paragraph>
            </Card>
          </Layout.Content>
        </Layout>
      </Layout>
    </App>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
