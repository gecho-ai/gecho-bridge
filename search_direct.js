#!/usr/bin/env node

const http = require('http');

async function searchTikTok(query) {
  console.log(`🔍 正在搜索 TikTok: "${query}"...`);
  
  return new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:18793/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          console.log(`✅ 搜索完成！状态码: ${res.statusCode}`);
          
          if (res.statusCode >= 400) {
            console.error(`❌ 错误: ${result.error || '未知错误'}`);
            reject(new Error(result.error || `HTTP ${res.statusCode}`));
          } else {
            console.log(`📊 获取到 ${Array.isArray(result.data) ? result.data.length : 0} 条结果`);
            
            // 显示前5条结果
            if (Array.isArray(result.data) && result.data.length > 0) {
              console.log('\n📈 点赞最高的前5条结果:');
              result.data.slice(0, 5).forEach((item, index) => {
                console.log(`${index + 1}. ${item.title || '无标题'}`);
                console.log(`   作者: ${item.author || '未知'}`);
                console.log(`   点赞: ${item.likes || 0} | 评论: ${item.comments || 0}`);
                console.log(`   链接: ${item.url || '无链接'}`);
                console.log('');
              });
            }
            
            resolve(result);
          }
        } catch (error) {
          console.error('❌ 解析响应失败:', error);
          reject(error);
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('❌ 请求失败:', error.message);
      reject(error);
    });
    
    req.write(JSON.stringify({
      action:'tiktok_insight',
      query:query,
    }));
    req.end();
  });
}

// 执行搜索
const query = process.argv[2] || '麦香鱼';
searchTikTok(query).catch(console.error);