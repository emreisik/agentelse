# Sağ dok (Photoshop tarzı panel rafı)

Sohbet ekranının sağ kenarında her zaman duran ince ikon sütunu (`src/components/workspace/workspace-dock.tsx`). Sağ panelin (Brand / Files / Outputs / Calendar) sekmeleri artık bu doktadır. Yazı yok; ad, üzerine gelince ipucunda görünür.

## Dok

1. **Panel düğmesi** (aç/kapat). Bir kart panelin yerini almışsa kartı da kapatır (`togglePanel`).
2. **Panel ikonları:** Brand, Files, Outputs, Calendar. Kapalıyken ikon paneli o bölümde açar. Açıkken başka bir ikon o bölüme geçer; gösterilen bölümün ikonu ise paneli kapatır (Photoshop'un dok davranışı, `dockPanelAction`). Açık bölümün ikonu basılı görünür.

Panel açıkken yazılı sekme satırı yoktur, çünkü dok panelin sekmeleridir. Panelde yalnız seçilen bölüm, küçük bir başlığın altında durur. Masaüstünde varsayılan yine açıktır (Meta incelemesindeki "Brand sekmesi" adımı için); kapatınca tercih tarayıcıda saklanır.

- **lg altında** panel sağdan açılan çekmecedir. Çekmece doku örttüğü için kendi küçük ikon satırı vardır.
- **Telefonda** (md altı) dok gizlidir; çekmeceyi ince üst bardaki düğme açar.

Sohbet kestirmeleri (Instagram post, araştırmalar vb.) dokta değil, sohbet kutusunun "+" menüsündedir. Bir süre dokta araç olarak da duruyorlardı; sahibin isteğiyle kaldırıldılar.

## Testler

`workspace-right-panel.test.ts` dokun ve panelin HTML'ini ve `dockPanelAction` kuralını sınar.
