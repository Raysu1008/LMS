// 替换 index.html 中的 loadReviewBuffer 函数（大约在 2379 行）
// 搜索 "function loadReviewBuffer()" 并替换为以下代码：

    function loadReviewBuffer() {
      console.log('[Review] Loading buffer...');
      google.script.run
        .withSuccessHandler(function(list) {
          console.log('[Review] Buffer loaded:', list);
          console.log('[Review] Number of items:', list ? list.length : 0);
          if (!list) {
            console.log('[Review] No data returned');
            return;
          }
          // pool-badge 只计 PENDING 数量
          var pendingCount = list.filter(function(i) { return (i.status||'').toUpperCase() === 'PENDING'; }).length;
          document.getElementById('pool-badge').innerText = pendingCount;
          document.getElementById('pool-badge').classList.toggle('hidden', pendingCount === 0);
          window.fullBuffer = list;
          console.log('[Review] Calling filterBuffer...');
          filterBuffer(); // 走过滤+排序+渲染统一入口
        })
        .withFailureHandler(function(e) {
          console.error('[Review] Load error:', e);
        })
        .getReviewBufferList();
    }
